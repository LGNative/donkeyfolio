use std::sync::Arc;

use rquest::cookie::{CookieStore, Jar};
use rquest::{Client, Url};
use serde_json::json;
use wealthfolio_core::secrets::SecretStore;

use crate::models::{LoginResponse, StoredCredentials};

const TR_API_BASE: &str = "https://api.traderepublic.com";
const CREDENTIALS_KEY: &str = "trade_republic_credentials";

#[derive(thiserror::Error, Debug)]
pub enum AuthError {
    #[error("No stored credentials")]
    NoCredentials,
    #[error("Login requires 2FA confirmation — waiting for user")]
    AwaitingConfirmation,
    #[error("HTTP error: {0}")]
    Http(#[from] rquest::Error),
    #[error("Invalid response: {0}")]
    InvalidResponse(String),
    #[error("Secret store error: {0}")]
    SecretStore(String),
    #[error("Login failed: {0}")]
    LoginFailed(String),
    #[error("Invalid credentials format: {0}")]
    InvalidInput(String),
}

pub struct TradeRepublicAuth {
    http: Client,
    cookies: Arc<Jar>,
}

impl TradeRepublicAuth {
    pub fn new() -> Self {
        let cookies = Arc::new(Jar::default());
        // rquest with Chrome TLS fingerprint impersonation — required to
        // bypass TR's AWS WAF bot-detection (same technique pytr uses via
        // curl_cffi). The User-Agent is part of the emulation profile.
        let http = Client::builder()
            .cookie_provider(Arc::clone(&cookies))
            .emulation(rquest_util::Emulation::Chrome131)
            .build()
            .expect("failed to build HTTP client");
        Self { http, cookies }
    }

    /// Validate phone number (E.164-ish: leading `+`, 8–15 digits).
    fn validate_phone(phone: &str) -> Result<(), AuthError> {
        let trimmed = phone.trim();
        if !trimmed.starts_with('+') {
            return Err(AuthError::InvalidInput(
                "phone must start with '+' (E.164 format, e.g. +351912345678)".into(),
            ));
        }
        let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
        if !(8..=15).contains(&digits.len()) {
            return Err(AuthError::InvalidInput(
                "phone must contain 8–15 digits (E.164)".into(),
            ));
        }
        Ok(())
    }

    /// Validate PIN (exactly 4 ASCII digits — Trade Republic's format).
    fn validate_pin(pin: &str) -> Result<(), AuthError> {
        if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
            return Err(AuthError::InvalidInput("PIN must be 4 digits".into()));
        }
        Ok(())
    }

    /// Store credentials encrypted in the OS keychain.
    pub fn save_credentials(
        store: &dyn SecretStore,
        phone: &str,
        pin: &str,
    ) -> Result<(), AuthError> {
        Self::validate_phone(phone)?;
        Self::validate_pin(pin)?;
        let creds = StoredCredentials {
            phone_number: phone.trim().to_string(),
            pin: pin.to_string(),
        };
        let json =
            serde_json::to_string(&creds).map_err(|e| AuthError::SecretStore(e.to_string()))?;
        store
            .set_secret(CREDENTIALS_KEY, &json)
            .map_err(|e| AuthError::SecretStore(e.to_string()))
    }

    /// Load credentials from the OS keychain.
    pub fn load_credentials(store: &dyn SecretStore) -> Result<StoredCredentials, AuthError> {
        let json = store
            .get_secret(CREDENTIALS_KEY)
            .map_err(|e| AuthError::SecretStore(e.to_string()))?
            .ok_or(AuthError::NoCredentials)?;
        serde_json::from_str(&json).map_err(|e| AuthError::SecretStore(e.to_string()))
    }

    /// Delete credentials from the OS keychain.
    pub fn delete_credentials(store: &dyn SecretStore) -> Result<(), AuthError> {
        store
            .delete_secret(CREDENTIALS_KEY)
            .map_err(|e| AuthError::SecretStore(e.to_string()))
    }

    /// Step 1: Initiate login — sends phone + PIN to TR.
    /// Returns a `process_id`. The user must then confirm on their phone.
    pub async fn initiate_login(&self, phone: &str, pin: &str) -> Result<LoginResponse, AuthError> {
        let resp = self
            .http
            .post(format!("{TR_API_BASE}/api/v1/auth/web/login"))
            .json(&json!({
                "phoneNumber": phone,
                "pin": pin,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AuthError::LoginFailed(format!("{status}: {body}")));
        }

        resp.json::<LoginResponse>()
            .await
            .map_err(|e| AuthError::InvalidResponse(e.to_string()))
    }

    /// Step 2: Confirm login with the 4-digit code shown on the TR app.
    /// On success the HTTP client's cookie jar holds `tr_session` and `tr_refresh`.
    pub async fn confirm_login(&self, process_id: &str, code: &str) -> Result<(), AuthError> {
        let resp = self
            .http
            .post(format!(
                "{TR_API_BASE}/api/v1/auth/web/login/{process_id}/{code}"
            ))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AuthError::LoginFailed(format!("{status}: {body}")));
        }

        Ok(())
    }

    /// Keep the session alive. Call every ~290 seconds.
    pub async fn refresh_session(&self) -> Result<(), AuthError> {
        let resp = self
            .http
            .get(format!("{TR_API_BASE}/api/v1/auth/web/session"))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(AuthError::LoginFailed("session refresh failed".into()));
        }
        Ok(())
    }

    /// Extract the `Cookie` header value for the TR API origin so the
    /// WebSocket handshake can reuse the session established over HTTPS.
    /// Returns `None` if there are no cookies for the TR domain yet
    /// (e.g. before confirm_login completes).
    pub fn session_cookie(&self) -> Option<String> {
        let url: Url = TR_API_BASE.parse().ok()?;
        let header = self.cookies.cookies(&url)?;
        header.to_str().ok().map(|s| s.to_string())
    }

    /// Reference to the HTTP client (shares cookie jar with WebSocket).
    pub fn http_client(&self) -> &Client {
        &self.http
    }
}
