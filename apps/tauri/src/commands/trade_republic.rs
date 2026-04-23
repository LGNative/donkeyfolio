use std::sync::Arc;

use log::{debug, info};
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::context::ServiceContext;
use crate::secret_store::KeyringSecretStore;

use trade_republic_connector::auth::TradeRepublicAuth;
use trade_republic_connector::sync::TradeRepublicSync;

/// Managed state for the TR connector — lives across commands.
pub struct TradeRepublicState {
    sync: Mutex<Option<TradeRepublicSync>>,
    process_id: Mutex<Option<String>>,
}

impl TradeRepublicState {
    pub fn new() -> Self {
        Self {
            sync: Mutex::new(None),
            process_id: Mutex::new(None),
        }
    }
}

// ── Response types ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrStatus {
    pub has_credentials: bool,
    pub is_connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrLoginStarted {
    pub process_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrCashEntry {
    pub currency: String,
    pub amount: rust_decimal::Decimal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrSyncResult {
    pub positions_count: usize,
    pub activities_created: usize,
    pub cash_balances: Vec<TrCashEntry>,
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn tr_get_status(
    tr_state: State<'_, Arc<TradeRepublicState>>,
) -> Result<TrStatus, String> {
    let has_credentials = TradeRepublicAuth::load_credentials(&KeyringSecretStore).is_ok();
    let is_connected = tr_state.sync.lock().await.is_some();
    Ok(TrStatus {
        has_credentials,
        is_connected,
    })
}

#[tauri::command]
pub async fn tr_save_credentials(phone_number: String, pin: String) -> Result<(), String> {
    debug!("Saving TR credentials to keychain");
    TradeRepublicAuth::save_credentials(&KeyringSecretStore, &phone_number, &pin)
        .map_err(|e| format!("Failed to save credentials: {e}"))
}

#[tauri::command]
pub async fn tr_delete_credentials(
    tr_state: State<'_, Arc<TradeRepublicState>>,
) -> Result<(), String> {
    info!("Deleting TR credentials and disconnecting");
    // Disconnect first
    if let Some(sync) = tr_state.sync.lock().await.take() {
        sync.disconnect().await;
    }
    *tr_state.process_id.lock().await = None;

    TradeRepublicAuth::delete_credentials(&KeyringSecretStore)
        .map_err(|e| format!("Failed to delete credentials: {e}"))
}

#[tauri::command]
pub async fn tr_start_login(
    tr_state: State<'_, Arc<TradeRepublicState>>,
) -> Result<TrLoginStarted, String> {
    debug!("Starting TR login");
    let sync = TradeRepublicSync::new();
    let process_id = sync
        .start_login(&KeyringSecretStore)
        .await
        .map_err(|e| format!("Login failed: {e}"))?;

    *tr_state.process_id.lock().await = Some(process_id.clone());
    *tr_state.sync.lock().await = Some(sync);

    Ok(TrLoginStarted { process_id })
}

#[tauri::command]
pub async fn tr_confirm_login(
    code: String,
    tr_state: State<'_, Arc<TradeRepublicState>>,
) -> Result<(), String> {
    let process_id = tr_state
        .process_id
        .lock()
        .await
        .clone()
        .ok_or("No pending login — call tr_start_login first")?;

    let guard = tr_state.sync.lock().await;
    let sync = guard.as_ref().ok_or("No sync instance")?;

    sync.confirm_login(&process_id, &code)
        .await
        .map_err(|e| format!("Confirm failed: {e}"))?;

    sync.connect_ws()
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    sync.start_keepalive();
    info!("TR connected and WebSocket active");
    Ok(())
}

#[tauri::command]
pub async fn tr_sync_portfolio(
    tr_state: State<'_, Arc<TradeRepublicState>>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<TrSyncResult, String> {
    info!("Syncing Trade Republic portfolio");

    let guard = tr_state.sync.lock().await;
    let sync = guard.as_ref().ok_or("Not connected — login first")?;

    // 1. Fetch positions
    let positions = sync
        .fetch_portfolio()
        .await
        .map_err(|e| format!("Failed to fetch portfolio: {e}"))?;
    let positions_count = positions.len();
    info!("Fetched {} positions from TR", positions_count);

    // 2. Fetch cash balance (displayed in UI, not persisted — timeline
    //    events already contain DEPOSIT/WITHDRAWAL flow).
    let cash = sync
        .fetch_cash()
        .await
        .map_err(|e| format!("Failed to fetch cash: {e}"))?;
    debug!("Fetched {} cash balance entries from TR", cash.len());
    let cash_balances: Vec<TrCashEntry> = cash
        .iter()
        .map(|c| TrCashEntry {
            currency: c.currency_id.clone(),
            amount: c.amount,
        })
        .collect();

    // 3. Fetch timeline (all transactions)
    let timeline = sync
        .fetch_all_timeline()
        .await
        .map_err(|e| format!("Failed to fetch timeline: {e}"))?;
    info!("Fetched {} timeline events from TR", timeline.len());

    // 4. Ensure a Trade Republic account exists
    let account_service = state.account_service();
    let accounts = account_service
        .get_all_accounts()
        .map_err(|e| format!("Failed to get accounts: {e}"))?;

    let account_id = match accounts
        .iter()
        .find(|a| a.platform_id.as_deref() == Some("trade_republic"))
    {
        Some(acc) => acc.id.clone(),
        None => {
            let new_account = wealthfolio_core::accounts::NewAccount {
                id: None,
                name: "Trade Republic".to_string(),
                account_type: "SECURITIES".to_string(),
                group: Some("Broker".to_string()),
                currency: "EUR".to_string(),
                is_default: false,
                is_active: true,
                platform_id: Some("trade_republic".to_string()),
                account_number: None,
                meta: None,
                provider: Some("TRADE_REPUBLIC".to_string()),
                provider_account_id: None,
                is_archived: false,
                tracking_mode: wealthfolio_core::accounts::TrackingMode::default(),
            };
            let acc: wealthfolio_core::accounts::Account = account_service
                .create_account(new_account)
                .await
                .map_err(|e| format!("Failed to create TR account: {e}"))?;
            info!("Created Trade Republic account: {}", acc.id);
            acc.id
        }
    };

    // 5. Convert timeline events to activities
    let activity_service = state.activity_service();
    let mut activities_created = 0usize;

    for item in &timeline {
        let event_type = item.event_type.as_deref().unwrap_or("UNKNOWN");
        let amount_val = item.amount.as_ref().map(|a| a.value).unwrap_or_default();
        let currency = item
            .amount
            .as_ref()
            .map(|a| a.currency.clone())
            .unwrap_or_else(|| "EUR".to_string());

        let activity_type =
            trade_republic_connector::sync::activity_type_from_amount(event_type, amount_val);

        if activity_type == "UNKNOWN" {
            debug!("Skipping unknown event type: {}", event_type);
            continue;
        }

        let activity_date = item.timestamp.map(|t| t.to_rfc3339()).unwrap_or_default();

        if activity_date.is_empty() {
            continue;
        }

        // Fetch detail for instrument events (BUY/SELL/DIVIDEND)
        let (symbol_input, quantity, unit_price, fee) =
            if matches!(activity_type, "BUY" | "SELL" | "DIVIDEND") {
                match sync.fetch_timeline_detail(&item.id).await {
                    Ok(detail) => extract_activity_fields(&detail),
                    Err(e) => {
                        debug!("Could not fetch detail for {}: {e}", item.id);
                        (None, None, None, None)
                    }
                }
            } else {
                (None, None, None, None)
            };

        let new_activity = wealthfolio_core::activities::NewActivity {
            id: None,
            account_id: account_id.clone(),
            symbol: symbol_input,
            activity_type: activity_type.to_string(),
            subtype: None,
            activity_date,
            quantity,
            unit_price,
            currency: currency.clone(),
            fee,
            amount: Some(amount_val.abs()),
            status: Some(wealthfolio_core::activities::ActivityStatus::Posted),
            notes: item.title.clone(),
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: Some("TRADE_REPUBLIC".to_string()),
            source_record_id: Some(item.id.clone()),
            source_group_id: None,
            idempotency_key: Some(format!("tr_{}", item.id)),
        };

        match activity_service.create_activity(new_activity).await {
            Ok(_) => activities_created += 1,
            Err(e) => {
                // Likely duplicate (idempotency key) — that's fine
                debug!("Activity create skipped for {}: {e}", item.id);
            }
        }
    }

    info!(
        "TR sync complete: {} positions, {} activities created",
        positions_count, activities_created
    );

    Ok(TrSyncResult {
        positions_count,
        activities_created,
        cash_balances,
    })
}

#[tauri::command]
pub async fn tr_disconnect(tr_state: State<'_, Arc<TradeRepublicState>>) -> Result<(), String> {
    info!("Disconnecting from Trade Republic");
    if let Some(sync) = tr_state.sync.lock().await.take() {
        sync.disconnect().await;
    }
    *tr_state.process_id.lock().await = None;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn extract_activity_fields(
    detail: &trade_republic_connector::models::TimelineDetail,
) -> (
    Option<wealthfolio_core::activities::SymbolInput>,
    Option<rust_decimal::Decimal>,
    Option<rust_decimal::Decimal>,
    Option<rust_decimal::Decimal>,
) {
    let mut isin: Option<String> = None;
    let mut name: Option<String> = None;
    let mut shares: Option<rust_decimal::Decimal> = None;
    let mut price: Option<rust_decimal::Decimal> = None;
    let mut fee: Option<rust_decimal::Decimal> = None;

    for section in &detail.sections {
        for entry in &section.data {
            let title = entry.title.as_deref().unwrap_or("");
            match title {
                "ISIN" => {
                    if let Some(trade_republic_connector::models::DetailValue::Text(ref v)) =
                        entry.detail
                    {
                        isin = Some(v.clone());
                    }
                }
                "Shares" | "Anteile" | "Stück" => {
                    if let Some(trade_republic_connector::models::DetailValue::Text(ref v)) =
                        entry.detail
                    {
                        shares = v.parse().ok();
                    }
                }
                "Price" | "Kurs" | "Share price" => {
                    if let Some(trade_republic_connector::models::DetailValue::Amount {
                        value,
                        ..
                    }) = &entry.detail
                    {
                        price = Some(*value);
                    }
                }
                "Fee" | "Gebühr" | "Fremdkostenzuschlag" => {
                    if let Some(trade_republic_connector::models::DetailValue::Amount {
                        value,
                        ..
                    }) = &entry.detail
                    {
                        fee = Some(value.abs());
                    }
                }
                _ => {}
            }
        }
    }

    // Use detail title as instrument name fallback
    if name.is_none() {
        name = detail.title_text.clone();
    }

    let symbol_input = isin.map(|isin_val| wealthfolio_core::activities::SymbolInput {
        id: None,
        symbol: Some(isin_val),
        exchange_mic: None,
        kind: Some("SECURITY".to_string()),
        name,
        quote_mode: Some("MARKET".to_string()),
        quote_ccy: None,
        instrument_type: None,
    });

    (symbol_input, shares, price, fee)
}
