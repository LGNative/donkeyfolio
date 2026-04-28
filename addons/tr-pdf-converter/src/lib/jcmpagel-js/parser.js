/* ====================================================================
 * PDF Transaction Parser (ported from standalone working logic)
 * ====================================================================
 * The implementation below mirrors the standalone script provided by
 * the user. It exposes the same parsing behaviour while allowing the
 * surrounding app code to handle UI concerns (status/progress display
 * and rendering of results).
 * ==================================================================== */

const PARSER_NOOP = () => {};

// --- Simple, Y-only footer band (adjust this) ---
const FOOTER_BOTTOM_BAND = 120; // points from the bottom to drop (try 150–220)

function normalizeHeaderText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^A-Z0-9]+/gi, " ")
    .trim()
    .toUpperCase();
}

function isCashStartLabel(text) {
  const normalized = normalizeHeaderText(text);
  return (
    normalized === "UMSATZUBERSICHT" ||
    normalized === "TRANSAZIONI SUL CONTO" ||
    normalized === "ACCOUNT TRANSACTIONS" ||
    normalized === "TRANSACTIONS SUR LE COMPTE" ||
    normalized === "TRANSACCIONES DE CUENTA"
  );
}

function isCashEndLabel(text) {
  const normalized = normalizeHeaderText(text);
  return (
    normalized.includes("BARMITTELUBERSICHT") ||
    normalized.includes("CASH SUMMARY") ||
    normalized.includes("BALANCE OVERVIEW") ||
    normalized.includes("APERCU DU SOLDE")
  );
}

function isInterestStartLabel(text) {
  const normalized = normalizeHeaderText(text);
  return (
    normalized === "TRANSAKTIONSUBERSICHT" || // DE
    normalized === "TRANSACTION OVERVIEW" || // EN
    normalized === "APERCU DES TRANSACTIONS" || // FR
    normalized === "RESUMO DE TRANSACOES" || // PT
    normalized === "RESUMO DAS TRANSACOES" || // PT (variant)
    normalized === "RESUMEN DE TRANSACCIONES" || // ES
    normalized === "PANORAMICA DELLE TRANSAZIONI" // IT
  );
}

function isInterestEndLabel(text) {
  const normalized = normalizeHeaderText(text);
  return (
    normalized.includes("HINWEISE ZUM KONTOAUSZUG") || // DE
    normalized.includes("NOTES TO ACCOUNT STATEMENT") || // EN
    normalized.includes("ACCOUNT STATEMENT NOTES") || // EN (variant)
    normalized.includes("NOTES RELATIVES AU RELEVE DE COMPTE") || // FR
    normalized.includes("OBSERVACOES SOBRE O EXTRATO DE CONTA") || // PT
    normalized.includes("NOTAS SOBRE O EXTRATO") || // PT (variant)
    normalized.includes("NOTAS DEL EXTRACTO") || // ES
    normalized.includes("NOTE SULL ESTRATTO CONTO") // IT
  );
}

/**
 * Parse the entire PDF and extract cash & interest transactions.
 * @param {PDFDocumentProxy} pdf
 * @param {{ updateStatus?: Function, updateProgress?: Function, footerBandPx?: number }} options
 * @returns {Promise<{ cash: Array<object>, interest: Array<object> }>}
 */
async function parsePDF(pdf, options = {}) {
  console.log("Starting PDF parsing...");
  const updateStatus = options.updateStatus || PARSER_NOOP;
  const updateProgress = options.updateProgress || PARSER_NOOP;

  // allow runtime override for band size
  const footerBandPx = Number.isFinite(options.footerBandPx)
    ? options.footerBandPx
    : FOOTER_BOTTOM_BAND;

  updateStatus("Parsing PDF...");
  let allCashTransactions = [];
  let allInterestTransactions = [];
  let cashColumnBoundaries = null;
  let interestColumnBoundaries = null;

  let isParsingCash = false;
  let isParsingInterest = false;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    console.log(`--- Processing Page ${pageNum} ---`);
    updateStatus(`Processing page ${pageNum} of ${pdf.numPages}`);
    updateProgress(pageNum, pdf.numPages);

    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    let pageItems = textContent.items.map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: item.height,
    }));
    console.log(`Page ${pageNum}: Found ${pageItems.length} total text items.`);

    // --- Simple Y-only footer clipping ---
    // pdf.js text y=0 is near the bottom; larger y is higher on the page.
    // We just drop everything with y <= footerBandPx (the bottom band).
    const footerY = footerBandPx;
    let items = pageItems.filter((it) => it.y > footerY);

    const detectedCashHeaders = findCashHeaders(items);
    const detectedInterestHeaders = findInterestHeaders(items);
    const hasCashHeaders = !!detectedCashHeaders;
    const hasInterestHeaders = !!detectedInterestHeaders;

    // The French cash section uses a generic "TRANSACTIONS" heading, so
    // section selection needs the column headers to disambiguate it.
    const cashStartMarker = items.find((item) => {
      const normalized = normalizeHeaderText(item.text);
      return (
        isCashStartLabel(item.text) ||
        (normalized === "TRANSACTIONS" && hasCashHeaders && !hasInterestHeaders)
      );
    });

    const cashEndMarker = items.find((item) => isCashEndLabel(item.text));
    const shouldProcessCash = isParsingCash || !!cashStartMarker || hasCashHeaders;

    const interestStartMarker = items.find((item) => {
      const normalized = normalizeHeaderText(item.text);
      return (
        isInterestStartLabel(item.text) ||
        (normalized === "TRANSACTIONS" && hasInterestHeaders && !hasCashHeaders)
      );
    });

    const interestEndMarker = items.find((item) => isInterestEndLabel(item.text));
    const shouldProcessInterest = isParsingInterest || !!interestStartMarker || hasInterestHeaders;

    // --- Cash Transaction Parsing Logic ---
    if (shouldProcessCash) {
      let cashItems = [...items];
      if (cashStartMarker) {
        cashItems = cashItems.filter((item) => item.y <= cashStartMarker.y);
      }
      if (cashEndMarker) {
        cashItems = cashItems.filter((item) => item.y > cashEndMarker.y);
      }

      let cashHeaders = detectedCashHeaders;
      if (cashStartMarker || cashEndMarker) {
        cashHeaders = findCashHeaders(cashItems);
      }
      if (cashHeaders) {
        cashColumnBoundaries = calculateCashColumnBoundaries(cashHeaders);
        console.log("Found new Cash headers and boundaries:", cashColumnBoundaries);
      }

      if (cashColumnBoundaries) {
        const pageCashTransactions = extractTransactionsFromPage(
          cashItems,
          cashColumnBoundaries,
          "cash",
        );
        console.log(`Page ${pageNum}: Extracted ${pageCashTransactions.length} cash transactions.`);
        allCashTransactions = allCashTransactions.concat(pageCashTransactions);
      }
    }
    if (cashEndMarker) {
      isParsingCash = false;
    } else if (shouldProcessCash) {
      isParsingCash = true;
    }

    // --- Interest Transaction Parsing Logic ---
    if (shouldProcessInterest) {
      let interestItems = [...items];
      if (interestStartMarker) {
        interestItems = interestItems.filter((item) => item.y <= interestStartMarker.y);
      }
      if (interestEndMarker) {
        interestItems = interestItems.filter((item) => item.y > interestEndMarker.y);
      }

      let interestHeaders = detectedInterestHeaders;
      if (interestStartMarker || interestEndMarker) {
        interestHeaders = findInterestHeaders(interestItems);
      }
      if (interestHeaders) {
        interestColumnBoundaries = calculateInterestColumnBoundaries(interestHeaders);
        console.log("Found new Interest headers and boundaries:", interestColumnBoundaries);
      } else if (isParsingInterest && interestColumnBoundaries) {
        console.log(
          `Page ${pageNum}: No new interest headers found, continuing with previous boundaries.`,
        );
      }

      if (interestColumnBoundaries) {
        const pageInterestTransactions = extractTransactionsFromPage(
          interestItems,
          interestColumnBoundaries,
          "interest",
        );
        console.log(
          `Page ${pageNum}: Extracted ${pageInterestTransactions.length} interest transactions.`,
        );
        allInterestTransactions = allInterestTransactions.concat(pageInterestTransactions);
      }
    }
    if (interestEndMarker) {
      isParsingInterest = false;
    } else if (shouldProcessInterest) {
      isParsingInterest = true;
    }
  }

  console.log(`Total cash transactions: ${allCashTransactions.length}`);
  console.log(`Total interest transactions: ${allInterestTransactions.length}`);
  return { cash: allCashTransactions, interest: allInterestTransactions };
}

// --- Generic and Cash-Specific Functions ---
function findCashHeaders(items) {
  const headerKeywords = [
    "DATUM",
    "TYP",
    "BESCHREIBUNG",
    "ZAHLUNGSEINGANG",
    "ZAHLUNGSAUSGANG",
    "SALDO",
    // Italian equivalents
    "DATA",
    "TIPO",
    "DESCRIZIONE",
    "IN ENTRATA",
    "IN USCITA",
    // English equivalents
    "DATE",
    "TYPE",
    "DESCRIPTION",
    "MONEY",
    "IN",
    "OUT",
    "BALANCE",
    // French equivalents
    "ENTREE",
    "SORTIE",
    "ARGENT",
    "SOLDE",
    // Spanish equivalents
    "FECHA",
    "DESCRIPCION",
    "ENTRADA",
    "SALIDA",
    "DINERO",
  ];
  const matchesHeaderKeyword = (text, keyword) => {
    if (keyword.length <= 3) return text === keyword;
    return text.includes(keyword);
  };

  const normalizedItems = items
    .map((item) => ({
      item,
      original: item.text.trim(),
      normalized: normalizeHeaderText(item.text),
    }))
    .filter((entry) => entry.normalized.length > 0);

  const uppercaseItems = normalizedItems
    .filter((entry) => {
      const t = entry.normalized;
      return t.length > 0 && t === t.toUpperCase();
    })
    .map((entry) => ({
      ...entry.item,
      _normalizedText: entry.normalized,
    }));

  const potentialHeaders = uppercaseItems.filter((item) => {
    const t = item._normalizedText || normalizeHeaderText(item.text);
    return headerKeywords.some((kw) => matchesHeaderKeyword(t, kw));
  });

  console.log(
    "Potential headers found:",
    potentialHeaders.map((h) => h.text.trim()),
  );

  const matchAny = (labels) => {
    const normalizedLabels = labels.map(normalizeHeaderText);
    return (
      potentialHeaders.find((p) =>
        normalizedLabels.includes(p._normalizedText || normalizeHeaderText(p.text)),
      ) || null
    );
  };

  // Helper to find headers that might be split into multiple text items (like "MONEY IN")
  const findCompositeHeader = (...parts) => {
    const normalizedParts = parts.map(normalizeHeaderText).filter(Boolean);
    const keywordPair = normalizedParts.join(" ").trim();
    const single = uppercaseItems.find((p) => {
      const t = p._normalizedText || normalizeHeaderText(p.text);
      return t === keywordPair || t === keywordPair.replace(/\s+/g, "");
    });
    if (single) return single;

    if (normalizedParts.length < 2) return null;

    const [firstPart, ...remainingParts] = normalizedParts;
    const firstCandidates = uppercaseItems.filter(
      (p) => (p._normalizedText || normalizeHeaderText(p.text)) === firstPart,
    );
    for (const f of firstCandidates) {
      const partsFound = [f];
      let previous = f;
      let failed = false;

      for (const part of remainingParts) {
        const nearby = uppercaseItems
          .filter((p) => (p._normalizedText || normalizeHeaderText(p.text)) === part)
          .filter(
            (p) =>
              Math.abs(p.y - previous.y) <= 6 &&
              p.x > previous.x - 2 &&
              p.x < previous.x + previous.width + 120,
          )
          .sort(
            (a, b) =>
              Math.abs(a.y - previous.y) - Math.abs(b.y - previous.y) ||
              a.x - previous.x - (b.x - previous.x),
          )[0];

        if (!nearby) {
          failed = true;
          break;
        }
        partsFound.push(nearby);
        previous = nearby;
      }

      if (failed) continue;

      const last = partsFound[partsFound.length - 1];

      return {
        text: parts.join(" "),
        x: f.x,
        y: Math.max(...partsFound.map((part) => part.y)),
        width: Math.max(f.width, last.x + last.width - f.x),
        height: Math.max(...partsFound.map((part) => part.height)),
      };
    }
    return null;
  };

  let headers = {
    DATUM: matchAny(["DATUM", "DATA", "DATE", "FECHA"]),
    TYP: matchAny(["TYP", "TIPO", "TYPE"]),
    BESCHREIBUNG: matchAny(["BESCHREIBUNG", "DESCRIZIONE", "DESCRIPTION", "DESCRIPCION"]),
    ZAHLUNGEN:
      potentialHeaders.find((p) => {
        const t = p._normalizedText || normalizeHeaderText(p.text);
        return (
          (t.includes("ZAHLUNGSEINGANG") && t.includes("ZAHLUNGSAUSGANG")) ||
          (t.includes("IN ENTRATA") && t.includes("IN USCITA")) ||
          (t.includes("MONEY IN") && t.includes("MONEY OUT")) ||
          (t.includes("ENTREE DARGENT") && t.includes("SORTIE DARGENT")) ||
          (t.includes("ENTRADA DE DINERO") && t.includes("SALIDA DE DINERO"))
        );
      }) || null,
    ZAHLUNGSEINGANG: null,
    ZAHLUNGSAUSGANG: null,
    SALDO: matchAny(["SALDO", "BALANCE", "SOLDE"]),
  };

  if (!headers.ZAHLUNGEN) {
    headers.ZAHLUNGSEINGANG =
      matchAny([
        "ZAHLUNGSEINGANG",
        "IN ENTRATA",
        "MONEY IN",
        "ENTRÉE D'ARGENT",
        "ENTREE D'ARGENT",
        "ENTREE DARGENT",
        "ENTRADA DE DINERO",
      ]) ||
      findCompositeHeader("MONEY", "IN") ||
      findCompositeHeader("ENTREE", "DARGENT") ||
      findCompositeHeader("ENTRADA DE", "DINERO");
    headers.ZAHLUNGSAUSGANG =
      matchAny([
        "ZAHLUNGSAUSGANG",
        "IN USCITA",
        "MONEY OUT",
        "SORTIE D'ARGENT",
        "SORTIE DARGENT",
        "SALIDA DE DINERO",
      ]) ||
      findCompositeHeader("MONEY", "OUT") ||
      findCompositeHeader("SORTIE", "DARGENT") ||
      findCompositeHeader("SALIDA DE", "DINERO");
  }

  console.log("Matched headers:", {
    DATUM: headers.DATUM?.text,
    TYP: headers.TYP?.text,
    BESCHREIBUNG: headers.BESCHREIBUNG?.text,
    ZAHLUNGSEINGANG: headers.ZAHLUNGSEINGANG?.text,
    ZAHLUNGSAUSGANG: headers.ZAHLUNGSAUSGANG?.text,
    SALDO: headers.SALDO?.text,
  });

  if (!headers.DATUM || !headers.TYP || !headers.BESCHREIBUNG || !headers.SALDO) return null;
  if (!headers.ZAHLUNGEN && (!headers.ZAHLUNGSEINGANG || !headers.ZAHLUNGSAUSGANG)) return null;
  return headers;
}

function calculateCashColumnBoundaries(headers) {
  let zahlungseingangEnd;
  let zahlungsausgangStart;
  let paymentsStart;

  if (headers.ZAHLUNGEN) {
    const zahlungenMidpoint = headers.ZAHLUNGEN.x + headers.ZAHLUNGEN.width / 2;
    zahlungseingangEnd = zahlungenMidpoint;
    zahlungsausgangStart = zahlungenMidpoint;
    paymentsStart = headers.ZAHLUNGEN.x - 5;
  } else {
    zahlungseingangEnd = headers.ZAHLUNGSAUSGANG.x - 5;
    zahlungsausgangStart = headers.ZAHLUNGSAUSGANG.x - 5;
    paymentsStart = headers.ZAHLUNGSEINGANG.x - 5;
  }

  return {
    datum: { start: 0, end: headers.TYP.x - 5 },
    typ: { start: headers.TYP.x - 5, end: headers.BESCHREIBUNG.x - 5 },
    beschreibung: { start: headers.BESCHREIBUNG.x - 5, end: paymentsStart },
    zahlungseingang: { start: paymentsStart, end: zahlungseingangEnd },
    zahlungsausgang: { start: zahlungsausgangStart, end: headers.SALDO.x - 5 },
    saldo: { start: headers.SALDO.x - 5, end: Infinity },
    headerY: headers.DATUM.y,
  };
}

// --- Interest-Specific Functions ---
//
// PATCH (Donkeyfolio v2.7.2): the upstream version of this function only
// recognised German headers (DATUM/ZAHLUNGSART/GELDMARKTFONDS/STÜCK/KURS PRO
// STÜCK/BETRAG), so any user with an English/Portuguese/Spanish/Italian/French
// TR statement got 0 MMF rows even when the section was present in the PDF.
// We now match the same multi-language strategy that findCashHeaders uses.
//
// Per-column synonyms:
//   datum    : DATUM      / DATE / DATA / FECHA
//   zahlungsart : ZAHLUNGSART / TYPE / TIPO / PAIEMENT
//   fund     : GELDMARKTFONDS / MONEY MARKET FUND / FUNDO / FONDO
//                         (PT 'FUNDO MERCADO MONETÁRIO', ES 'FONDO MONETARIO')
//   stueck   : STÜCK / QUANTITY / QUANTIDADE / CANTIDAD / QUANTITÀ / PEZZI
//   kurs     : KURS PRO STÜCK / PRICE PER UNIT / PRICE / PREÇO / PRECIO / PRIX
//   betrag   : BETRAG / AMOUNT / MONTANTE / IMPORTE / IMPORTO
const INTEREST_HEADER_SYNONYMS = {
  DATUM: ["DATUM", "DATE", "DATA", "FECHA"],
  ZAHLUNGSART: ["ZAHLUNGSART", "TYPE", "TIPO"],
  GELDMARKTFONDS: ["GELDMARKTFONDS", "MONEY MARKET FUND", "FUNDO", "FONDO"],
  STÜCK: ["STÜCK", "STUECK", "QUANTITY", "QUANTIDADE", "CANTIDAD", "QUANTITÀ", "QUANTITA", "PEZZI"],
  "KURS PRO STÜCK": [
    "KURS PRO STÜCK",
    "KURS PRO STUECK",
    "PRICE PER UNIT",
    "PRICE",
    "PREÇO",
    "PRECO",
    "PRECIO",
    "PRIX",
  ],
  BETRAG: ["BETRAG", "AMOUNT", "MONTANTE", "IMPORTE", "IMPORTO"],
};

function findInterestHeaders(items) {
  // Flat list of all keywords in any language for the initial filter.
  const flatKeywords = Object.values(INTEREST_HEADER_SYNONYMS).flat();

  // First pass: any uppercase-ish item that contains one of the keywords.
  // We compare against normalised text (no diacritics) to handle PT 'PREÇO'
  // matching 'PRECO' etc.
  const potentialHeaders = items.filter((item) => {
    const t = (item.text || "").trim();
    if (t.length < 2) return false;
    if (t !== t.toUpperCase()) return false;
    const norm = normalizeHeaderText(t);
    return flatKeywords.some((kw) => norm.includes(normalizeHeaderText(kw)));
  });

  // Resolve each canonical header by trying its synonyms in order.
  const resolve = (synonyms) => {
    for (const syn of synonyms) {
      const target = normalizeHeaderText(syn);
      const hit = potentialHeaders.find(
        (p) => normalizeHeaderText((p.text || "").trim()) === target,
      );
      if (hit) return hit;
    }
    // Fallback: substring match (e.g. PT 'FUNDO MERCADO MONETÁRIO' contains 'FUNDO').
    for (const syn of synonyms) {
      const target = normalizeHeaderText(syn);
      const hit = potentialHeaders.find((p) =>
        normalizeHeaderText((p.text || "").trim()).includes(target),
      );
      if (hit) return hit;
    }
    return undefined;
  };

  const headers = {
    DATUM: resolve(INTEREST_HEADER_SYNONYMS.DATUM),
    ZAHLUNGSART: resolve(INTEREST_HEADER_SYNONYMS.ZAHLUNGSART),
    GELDMARKTFONDS: resolve(INTEREST_HEADER_SYNONYMS.GELDMARKTFONDS),
    STÜCK: resolve(INTEREST_HEADER_SYNONYMS.STÜCK),
    "KURS PRO STÜCK": resolve(INTEREST_HEADER_SYNONYMS["KURS PRO STÜCK"]),
    BETRAG: resolve(INTEREST_HEADER_SYNONYMS.BETRAG),
  };

  if (Object.values(headers).some((h) => !h)) {
    // For diagnostics in the dev console.
    const missing = Object.entries(headers)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (potentialHeaders.length > 0) {
      console.log(
        "[findInterestHeaders] missing canonical headers:",
        missing,
        "— candidates seen:",
        potentialHeaders.map((p) => p.text.trim()),
      );
    }
    return null;
  }
  return headers;
}

function calculateInterestColumnBoundaries(headers) {
  return {
    datum: { start: 0, end: headers.ZAHLUNGSART.x - 5 },
    zahlungsart: { start: headers.ZAHLUNGSART.x - 5, end: headers.GELDMARKTFONDS.x - 5 },
    geldmarktfonds: { start: headers.GELDMARKTFONDS.x - 5, end: headers.STÜCK.x - 5 },
    stueck: { start: headers.STÜCK.x - 5, end: headers["KURS PRO STÜCK"].x - 5 },
    kurs: { start: headers["KURS PRO STÜCK"].x - 5, end: headers.BETRAG.x - 5 },
    betrag: { start: headers.BETRAG.x - 5, end: Infinity },
    headerY: headers.DATUM.y,
  };
}

function cleanExtractedField(value, key) {
  const normalized = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Limit null-artifact cleanup to description-like fields.
  if (key === "beschreibung" || key === "geldmarktfonds") {
    return normalized.replace(/(?:\s*null)+$/gi, "").trim();
  }
  return normalized;
}

// --- Generic Transaction Extraction ---
function extractTransactionsFromPage(items, boundaries, type) {
  const contentItems = items.filter(
    (item) => item.y < boundaries.headerY - 5 && item.text.trim() !== "",
  );
  if (contentItems.length === 0) return [];

  contentItems.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  if (contentItems.length > 0) {
    const avgHeight =
      contentItems.reduce((sum, item) => sum + item.height, 0) / contentItems.length || 10;
    const gapThreshold = avgHeight * 1.5;
    let currentRow = [contentItems[0]];
    for (let i = 1; i < contentItems.length; i++) {
      if (contentItems[i - 1].y - contentItems[i].y > gapThreshold) {
        rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push(contentItems[i]);
    }
    rows.push(currentRow);
  }

  const transactions = [];
  for (const rowItems of rows) {
    let transaction = {};

    if (type === "cash") {
      transaction = {
        datum: "",
        typ: "",
        beschreibung: "",
        zahlungseingang: "",
        zahlungsausgang: "",
        saldo: "",
      };
      const financialItems = [];
      for (const item of rowItems) {
        if (item.x < boundaries.datum.end) transaction.datum += " " + item.text;
        else if (item.x < boundaries.typ.end) transaction.typ += " " + item.text;
        else if (item.x < boundaries.beschreibung.end) transaction.beschreibung += " " + item.text;
        else financialItems.push(item);
      }
      financialItems.sort((a, b) => a.x - b.x);
      if (financialItems.length > 0) transaction.saldo = financialItems.pop().text;
      for (const item of financialItems) {
        if (item.x < boundaries.zahlungseingang.end) transaction.zahlungseingang += " " + item.text;
        else if (item.x < boundaries.zahlungsausgang.end)
          transaction.zahlungsausgang += " " + item.text;
      }
    } else if (type === "interest") {
      transaction = {
        datum: "",
        zahlungsart: "",
        geldmarktfonds: "",
        stueck: "",
        kurs: "",
        betrag: "",
      };
      const otherItems = [];
      for (const item of rowItems) {
        if (item.x < boundaries.datum.end) transaction.datum += " " + item.text;
        else if (item.x < boundaries.zahlungsart.end) transaction.zahlungsart += " " + item.text;
        else if (item.x < boundaries.geldmarktfonds.end)
          transaction.geldmarktfonds += " " + item.text;
        else otherItems.push(item);
      }
      otherItems.sort((a, b) => a.x - b.x);
      if (otherItems.length > 0) {
        const betragItem = otherItems.pop();
        transaction.betrag = betragItem.text;
      }
      for (const item of otherItems) {
        if (item.x < boundaries.stueck.end) transaction.stueck += " " + item.text;
        else if (item.x < boundaries.kurs.end) transaction.kurs += " " + item.text;
      }
    }

    Object.keys(transaction).forEach((key) => {
      transaction[key] = cleanExtractedField(transaction[key], key);
    });
    if (Object.values(transaction).some((val) => val !== "")) {
      transactions.push(transaction);
    }
  }
  return transactions;
}

function parseCurrency(str) {
  if (!str || typeof str !== "string") return 0;

  let cleanStr = str
    .replace(/€/g, "")
    .replace(/[^\d,.\-]/g, "")
    .trim();

  const hasComma = cleanStr.includes(",");
  const hasDot = cleanStr.includes(".");

  if (hasComma && hasDot) {
    if (cleanStr.lastIndexOf(",") > cleanStr.lastIndexOf(".")) {
      // European format: 1.234,56
      cleanStr = cleanStr.replace(/\./g, "").replace(/,/g, ".");
    } else {
      // English format: 1,234.56
      cleanStr = cleanStr.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Assume comma decimal separator
    cleanStr = cleanStr.replace(/\./g, "").replace(/,/g, ".");
  } else {
    // Dot-only values can still contain thousand separators.
    cleanStr = cleanStr.replace(/\.(?=\d{3}(?:\.|$))/g, "");
  }

  return isNaN(parseFloat(cleanStr)) ? 0 : parseFloat(cleanStr);
}

/**
 * Attach derived metadata (optional helper, used by UI layer).
 */
function computeCashSanityChecks(transactions) {
  let failedChecks = 0;
  const enhancedTransactions = transactions.map((t, index, list) => {
    let sanityCheckOk = true;
    if (index > 0) {
      const prevSaldo = parseCurrency(list[index - 1].saldo);
      const eingang = parseCurrency(t.zahlungseingang);
      const ausgang = parseCurrency(t.zahlungsausgang);
      const currentSaldo = parseCurrency(t.saldo);
      if (!isNaN(prevSaldo) && !isNaN(currentSaldo)) {
        const expectedSaldo = prevSaldo + eingang - ausgang;
        if (Math.abs(expectedSaldo - currentSaldo) > 0.02) {
          sanityCheckOk = false;
          failedChecks++;
        }
      }
    }
    return { ...t, _sanityCheckOk: sanityCheckOk };
  });
  return { transactions: enhancedTransactions, failedChecks };
}

// expose helper so other modules can reuse sanity information
window.parsePDF = parsePDF;
window.parseCurrency = parseCurrency;
window.computeCashSanityChecks = computeCashSanityChecks;
window.findCashHeaders = findCashHeaders;
window.findInterestHeaders = findInterestHeaders;
