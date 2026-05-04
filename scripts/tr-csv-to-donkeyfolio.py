#!/usr/bin/env python3
"""
Convert Trade Republic export CSV (cash-N.csv) → Donkeyfolio import CSV.

TR exports `datum;typ;beschreibung;zahlungseingang;zahlungsausgang;saldo`
in German format. Donkeyfolio's import wizard expects the standard
`date,activityType,symbol,isin,quantity,unitPrice,amount,currency,fee,...`
schema. This script does the categorization that our PDF parser does,
but using the CSV which has a `saldo` running-balance column as ground
truth — so we know exactly what cash should end up at.

Usage:
    python3 tr-csv-to-donkeyfolio.py <input.csv> [output.csv]
"""
import csv
import re
import sys
from pathlib import Path

MONTHS = {
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05",
    "Jun": "06", "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10",
    "Nov": "11", "Dec": "12",
}

CRYPTO_ISIN_TO_SYMBOL = {
    "XF000BTC0017": "BTC",
    "XF000ETH0019": "ETH",
    "XF000SOL0012": "SOL",
    "XF000ADA0018": "ADA",
    "XF000XRP0018": "XRP",
}


def parse_eur(s: str) -> float:
    if not s:
        return 0.0
    s = s.replace("€", "").replace(" ", "").strip()
    if not s:
        return 0.0
    s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_date(s: str) -> str:
    """20 Jun 2024 → 2024-06-20"""
    m = re.match(r"(\d{1,2})\s+(\w{3})\s+(\d{4})", s.strip())
    if not m:
        return s
    d, mo, y = m.groups()
    return f"{y}-{MONTHS.get(mo, '01')}-{d.zfill(2)}"


def extract_isin(desc: str) -> str | None:
    m = re.search(r"\b([A-Z]{2}[A-Z0-9]{10})\b", desc)
    if m:
        return m.group(1)
    m = re.search(r"\b(XF000[A-Z0-9]{6,7})\b", desc)
    if m:
        return m.group(1)
    return None


def extract_qty(desc: str) -> float | None:
    m = re.search(r"quantity:\s*([\d.,]+)", desc, re.IGNORECASE)
    if not m:
        return None
    raw = m.group(1).replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def classify(typ: str, desc: str, inc: float, out: float) -> tuple[str, str | None]:
    """Returns (activityType, subtype). subtype matches Wealthfolio's Title Case format."""
    typ_l = typ.lower().strip()
    d = desc.lower()

    if typ_l == "trade":
        if "buy trade" in d or "savings plan execution" in d or "compra direta" in d:
            # Wealthfolio core has no "TR_SAVINGS_PLAN" subtype — leave empty.
            return "BUY", None
        if "sell trade" in d or "venda direta" in d:
            return "SELL", None
        return "BUY" if out > 0 else "SELL", None  # fallback

    if typ_l == "earnings":
        if "drip" in d or "reinvest" in d or "wiederanlage" in d:
            return "DIVIDEND", "DRIP"
        if "stock distribution" in d or "dividend in kind" in d:
            return "DIVIDEND", "Dividend in Kind"
        return "DIVIDEND", None

    if typ_l == "interest":
        if "staking" in d or "stake reward" in d:
            return "INTEREST", "Staking Reward"
        return "INTEREST", None

    if typ_l == "transfer":
        return ("DEPOSIT", None) if inc > 0 else ("WITHDRAWAL", None)

    if typ_l == "card transaction":
        # Card refund (incoming) → CREDIT/Fee Refund. Spending (out) → WITHDRAWAL.
        if inc > 0:
            return "CREDIT", "Fee Refund"
        return "WITHDRAWAL", None

    if typ_l == "reward":
        # Saveback → Trading Rebate (reduces costs, not new capital).
        # Cash reward allocation → Bonus (promo / referral / similar).
        if "saveback" in d or "round up" in d or "round-up" in d:
            return "CREDIT", "Trading Rebate"
        return "CREDIT", "Bonus"

    if typ_l == "fee":
        return "FEE", None

    if typ_l == "tax":
        return "TAX", None

    return ("CREDIT" if inc > 0 else "WITHDRAWAL"), None


def convert(input_path: Path, output_path: Path) -> dict:
    rows_out = []
    stats = {"trades_buy": 0, "trades_sell": 0, "dividends": 0, "interest": 0,
             "deposits": 0, "withdrawals": 0, "credits": 0, "fees": 0, "taxes": 0,
             "skipped": 0}

    with input_path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            date = parse_date(row.get("datum", ""))
            typ = row.get("typ", "").strip()
            desc = row.get("beschreibung", "")
            inc = parse_eur(row.get("zahlungseingang", ""))
            out = parse_eur(row.get("zahlungsausgang", ""))
            if inc == 0 and out == 0:
                stats["skipped"] += 1
                continue

            activity_type, subtype = classify(typ, desc, inc, out)
            isin = extract_isin(desc)
            qty = extract_qty(desc)
            amount = inc if inc > 0 else out

            symbol = ""
            instrument_type = ""
            if isin:
                if isin.startswith("XF000") and isin in CRYPTO_ISIN_TO_SYMBOL:
                    symbol = f"{CRYPTO_ISIN_TO_SYMBOL[isin]}-EUR"
                    instrument_type = "Crypto"
                else:
                    symbol = isin
                    instrument_type = "Equity"
            elif activity_type in ("DEPOSIT", "WITHDRAWAL", "INTEREST", "CREDIT", "FEE", "TAX"):
                symbol = "$CASH-EUR"
                instrument_type = "Cash"

            # Compute fee + unit price for trades
            fee = ""
            unit_price = ""
            gross_amount = amount
            if activity_type in ("BUY", "SELL") and qty and qty > 0:
                # TR fee: €0 savings plan only. Manual buy/sell + crypto direct
                # buy/sell = €1 flat external fee. BUT TR waives the fee on tiny
                # trades where amount <= fee (would result in negative gross),
                # so detect that case and set fee=0.
                is_savings = "savings plan" in desc.lower()
                expected_fee = 0 if is_savings else 1
                if activity_type == "BUY":
                    gross_candidate = amount - expected_fee
                    if gross_candidate > 0:
                        gross_amount = gross_candidate
                        fee = expected_fee
                    else:
                        gross_amount = amount
                        fee = 0
                else:
                    gross_amount = amount + expected_fee
                    fee = expected_fee
                unit_price = gross_amount / qty if qty > 0 else ""

            rows_out.append({
                "date": date,
                "activityType": activity_type,
                "symbol": symbol,
                "isin": isin if isin and not isin.startswith("XF000") else "",
                "quantity": qty if qty else (1 if activity_type not in ("BUY", "SELL") else ""),
                "unitPrice": unit_price if unit_price else (amount if activity_type not in ("BUY", "SELL") else ""),
                "amount": gross_amount if activity_type in ("BUY", "SELL") else amount,
                "currency": "EUR",
                "fee": fee,
                "fxRate": 1,
                "comment": desc[:150],
                "subtype": subtype or "",
                "instrumentType": instrument_type,
            })

            # Stats
            if activity_type == "BUY":
                stats["trades_buy"] += 1
            elif activity_type == "SELL":
                stats["trades_sell"] += 1
            elif activity_type == "DIVIDEND":
                stats["dividends"] += 1
            elif activity_type == "INTEREST":
                stats["interest"] += 1
            elif activity_type == "DEPOSIT":
                stats["deposits"] += 1
            elif activity_type == "WITHDRAWAL":
                stats["withdrawals"] += 1
            elif activity_type == "CREDIT":
                stats["credits"] += 1
            elif activity_type == "FEE":
                stats["fees"] += 1
            elif activity_type == "TAX":
                stats["taxes"] += 1

    # Write output
    headers = ["date", "activityType", "symbol", "isin", "quantity", "unitPrice",
               "amount", "currency", "fee", "fxRate", "comment", "subtype",
               "instrumentType"]
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for r in rows_out:
            writer.writerow(r)

    stats["total"] = len(rows_out)
    return stats


def main():
    if len(sys.argv) < 2:
        print("Usage: tr-csv-to-donkeyfolio.py <input.csv> [output.csv]")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else input_path.with_suffix(".donkeyfolio.csv")

    if not input_path.exists():
        print(f"Error: {input_path} does not exist")
        sys.exit(1)

    stats = convert(input_path, output_path)
    print(f"Wrote {stats['total']} rows to {output_path}")
    print()
    for k, v in stats.items():
        if k != "total":
            print(f"  {k:15s} {v:>5d}")


if __name__ == "__main__":
    main()
