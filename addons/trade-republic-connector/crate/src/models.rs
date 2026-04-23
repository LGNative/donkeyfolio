use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

// ── Auth ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub process_id: String,
    #[serde(default)]
    pub countdown_in_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    pub session_token: String,
    pub refresh_token: String,
}

/// Credentials stored in the OS keychain.
///
/// `ZeroizeOnDrop` wipes the PIN (and phone) from memory when the struct
/// is dropped. This is best-effort — intermediate copies created by serde
/// or the HTTP client are outside our control.
#[derive(Debug, Clone, Serialize, Deserialize, zeroize::ZeroizeOnDrop)]
pub struct StoredCredentials {
    pub phone_number: String,
    pub pin: String,
}

// ── Portfolio ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactPortfolio {
    #[serde(default)]
    pub positions: Vec<PortfolioPosition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioPosition {
    pub instrument_id: String,
    pub net_size: Decimal,
    pub average_buy_in: Decimal,
    #[serde(default)]
    pub derivative_info: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashBalance {
    #[serde(default)]
    pub currency_id: String,
    #[serde(default)]
    pub amount: Decimal,
}

// ── Timeline ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResponse {
    #[serde(default)]
    pub items: Vec<TimelineItem>,
    #[serde(default)]
    pub cursors: Option<TimelineCursors>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineCursors {
    pub after: Option<String>,
    pub before: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub id: String,
    #[serde(default)]
    pub timestamp: Option<DateTime<Utc>>,
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub amount: Option<AmountValue>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountValue {
    #[serde(default)]
    pub value: Decimal,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub fraction_digits: Option<u8>,
}

// ── Timeline Detail ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDetail {
    pub id: String,
    #[serde(default)]
    pub title_text: Option<String>,
    #[serde(default)]
    pub subtitle_text: Option<String>,
    #[serde(default)]
    pub timestamp: Option<DateTime<Utc>>,
    #[serde(default)]
    pub sections: Vec<DetailSection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSection {
    #[serde(rename = "type")]
    pub section_type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub data: Vec<DetailEntry>,
    #[serde(default)]
    pub action: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailEntry {
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail: Option<DetailValue>,
    #[serde(default)]
    pub action: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum DetailValue {
    Text(String),
    Amount {
        value: Decimal,
        currency: String,
        #[serde(default)]
        fraction_digits: Option<u8>,
    },
    Structured(serde_json::Value),
}

// ── Instrument ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub isin: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub instrument_type: Option<String>,
    #[serde(default)]
    pub exchange_ids: Vec<String>,
    #[serde(default)]
    pub image_id: Option<String>,
}

// ── WebSocket Protocol ──────────────────────────────────────────────────────

/// Parsed server message from the TR WebSocket.
#[derive(Debug, Clone)]
pub enum WsMessage {
    Connected,
    Answer { id: u32, payload: serde_json::Value },
    Delta { id: u32, raw: String },
    Complete { id: u32 },
    Error { id: u32, payload: serde_json::Value },
    Echo,
    Unknown(String),
}
