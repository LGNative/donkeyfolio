use rust_decimal::Decimal;
use serde_json::json;
use wealthfolio_core::secrets::SecretStore;

use crate::auth::TradeRepublicAuth;
use crate::models::{
    CashBalance, CompactPortfolio, Instrument, PortfolioPosition, TimelineDetail, TimelineItem,
    TimelineResponse,
};
use crate::websocket::TradeRepublicClient;

#[derive(thiserror::Error, Debug)]
pub enum SyncError {
    #[error("Auth error: {0}")]
    Auth(#[from] crate::auth::AuthError),
    #[error("WebSocket error: {0}")]
    Ws(#[from] crate::websocket::WsError),
    #[error("Deserialization error: {0}")]
    Deserialize(String),
}

/// High-level sync interface for Trade Republic data.
/// All data stays local — no cloud intermediary.
pub struct TradeRepublicSync {
    auth: TradeRepublicAuth,
    ws: TradeRepublicClient,
}

impl TradeRepublicSync {
    pub fn new() -> Self {
        Self {
            auth: TradeRepublicAuth::new(),
            ws: TradeRepublicClient::new(),
        }
    }

    /// Full login flow — step 1.
    /// Returns a process_id; the user must confirm on their TR app.
    pub async fn start_login(&self, store: &dyn SecretStore) -> Result<String, SyncError> {
        let creds = TradeRepublicAuth::load_credentials(store)?;
        let resp = self
            .auth
            .initiate_login(&creds.phone_number, &creds.pin)
            .await?;
        Ok(resp.process_id)
    }

    /// Full login flow — step 2.
    /// After user confirms, call this with the 4-digit code.
    pub async fn confirm_login(&self, process_id: &str, code: &str) -> Result<(), SyncError> {
        self.auth.confirm_login(process_id, code).await?;
        Ok(())
    }

    /// Connect the WebSocket (call after successful login).
    /// Passes the authenticated session cookie from the HTTP client so TR
    /// recognises the WS handshake as the logged-in user.
    pub async fn connect_ws(&self) -> Result<(), SyncError> {
        let cookie = self.auth.session_cookie();
        self.ws.connect(cookie.as_deref()).await?;
        Ok(())
    }

    /// Fetch current portfolio positions.
    pub async fn fetch_portfolio(&self) -> Result<Vec<PortfolioPosition>, SyncError> {
        let data = self
            .ws
            .subscribe_and_wait(json!({"type": "compactPortfolio"}))
            .await?;
        let portfolio: CompactPortfolio =
            serde_json::from_value(data).map_err(|e| SyncError::Deserialize(e.to_string()))?;
        Ok(portfolio.positions)
    }

    /// Fetch cash balance.
    pub async fn fetch_cash(&self) -> Result<Vec<CashBalance>, SyncError> {
        let data = self.ws.subscribe_and_wait(json!({"type": "cash"})).await?;

        // TR returns either a single object or an array
        let balances: Vec<CashBalance> = if data.is_array() {
            serde_json::from_value(data).map_err(|e| SyncError::Deserialize(e.to_string()))?
        } else {
            let single: CashBalance =
                serde_json::from_value(data).map_err(|e| SyncError::Deserialize(e.to_string()))?;
            vec![single]
        };
        Ok(balances)
    }

    /// Fetch paginated timeline transactions.
    /// Pass `after` cursor for pagination (None for first page).
    pub async fn fetch_timeline(&self, after: Option<&str>) -> Result<TimelineResponse, SyncError> {
        let payload = match after {
            Some(cursor) => json!({"type": "timelineTransactions", "after": cursor}),
            None => json!({"type": "timelineTransactions"}),
        };
        let data = self.ws.subscribe_and_wait(payload).await?;
        serde_json::from_value(data).map_err(|e| SyncError::Deserialize(e.to_string()))
    }

    /// Fetch all timeline transactions (auto-paginate).
    pub async fn fetch_all_timeline(&self) -> Result<Vec<TimelineItem>, SyncError> {
        let mut all_items = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let page = self.fetch_timeline(cursor.as_deref()).await?;
            let has_more = page
                .cursors
                .as_ref()
                .and_then(|c| c.after.as_ref())
                .is_some();

            all_items.extend(page.items);

            if !has_more {
                break;
            }
            cursor = page.cursors.and_then(|c| c.after);
        }

        Ok(all_items)
    }

    /// Fetch detail for a single timeline event (fees, taxes, shares, ISIN).
    pub async fn fetch_timeline_detail(&self, event_id: &str) -> Result<TimelineDetail, SyncError> {
        let data = self
            .ws
            .subscribe_and_wait(json!({"type": "timelineDetailV2", "id": event_id}))
            .await?;
        serde_json::from_value(data).map_err(|e| SyncError::Deserialize(e.to_string()))
    }

    /// Fetch instrument metadata by ISIN.
    pub async fn fetch_instrument(&self, isin: &str) -> Result<Instrument, SyncError> {
        let data = self
            .ws
            .subscribe_and_wait(json!({"type": "instrument", "id": isin}))
            .await?;
        serde_json::from_value(data).map_err(|e| SyncError::Deserialize(e.to_string()))
    }

    /// Start the echo keepalive (run after connect_ws).
    pub fn start_keepalive(&self) -> tokio::task::JoinHandle<()> {
        self.ws.spawn_keepalive()
    }

    /// Disconnect cleanly.
    pub async fn disconnect(&self) {
        self.ws.disconnect().await;
    }
}

// ── Activity Type Mapping ───────────────────────────────────────────────────

/// Map a TR timeline event type to a Donkeyfolio activity type string.
pub fn map_tr_event_to_activity_type(event_type: &str) -> Option<&'static str> {
    match event_type {
        // Buys
        "ORDER_EXECUTED" | "SAVINGS_PLAN_EXECUTED" | "TRADE_INVOICE"
            if is_buy_context(event_type) =>
        {
            Some("BUY")
        }

        // Sells
        "ORDER_EXECUTED" | "TRADE_INVOICE" => Some("SELL"),

        // Dividends
        "CREDIT" => Some("DIVIDEND"),

        // Interest
        "INTEREST_PAYOUT" | "INTEREST_PAYOUT_CREATED" => Some("INTEREST"),

        // Deposits
        "PAYMENT_INBOUND" | "INCOMING_TRANSFER" | "ACCOUNT_TRANSFER_INCOMING" => Some("DEPOSIT"),

        // Withdrawals
        "OUTGOING_TRANSFER" | "PAYMENT_OUTBOUND" => Some("WITHDRAWAL"),

        // Tax
        "TAX_CORRECTION" | "TAX_REFUND" => Some("TAX"),

        // Fees
        "FEE_CHARGED" => Some("FEE"),

        _ => None,
    }
}

fn is_buy_context(_event_type: &str) -> bool {
    // In practice, buy vs sell is determined by the sign of the amount
    // in the timeline detail, not just the event type.
    // This is a placeholder — the sync logic uses amount.value > 0 for buys.
    true
}

/// Determine buy vs sell from the transaction amount.
pub fn activity_type_from_amount(event_type: &str, amount: Decimal) -> &'static str {
    match event_type {
        "ORDER_EXECUTED" | "SAVINGS_PLAN_EXECUTED" | "TRADE_INVOICE" => {
            if amount < Decimal::ZERO {
                "BUY" // negative amount = money spent = buy
            } else {
                "SELL"
            }
        }
        "CREDIT" => "DIVIDEND",
        "INTEREST_PAYOUT" | "INTEREST_PAYOUT_CREATED" => "INTEREST",
        "PAYMENT_INBOUND" | "INCOMING_TRANSFER" | "ACCOUNT_TRANSFER_INCOMING" => "DEPOSIT",
        "OUTGOING_TRANSFER" | "PAYMENT_OUTBOUND" => "WITHDRAWAL",
        "TAX_CORRECTION" | "TAX_REFUND" => "TAX",
        _ => "UNKNOWN",
    }
}
