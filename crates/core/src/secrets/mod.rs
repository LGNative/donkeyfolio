use crate::errors::Result;

/// Prefix applied to all secret identifiers to avoid collisions with other
/// applications that may share the same underlying credential store.
///
/// Resolved at compile time from DONKEYFOLIO_SECRET_PREFIX (set by
/// scripts/tauri-wrapper.mjs from .env.local). Falls back to "wealthfolio_"
/// to stay compatible with upstream Wealthfolio keychain entries if the
/// env var is unset.
pub const SERVICE_PREFIX: &str = match option_env!("DONKEYFOLIO_SECRET_PREFIX") {
    Some(v) => v,
    None => "wealthfolio_",
};

/// Format a service identifier into the canonical form expected by the
/// platform-specific secret stores.
pub fn format_service_id(service: &str) -> String {
    format!("{}{}", SERVICE_PREFIX, service.to_lowercase())
}

/// Platform-agnostic contract for storing provider secrets. Concrete
/// implementations live in the platform crates (e.g. the Tauri desktop app or
/// the self-hosted web server) so the core crate remains focused on business
/// logic.
pub trait SecretStore: Send + Sync {
    fn set_secret(&self, service: &str, secret: &str) -> Result<()>;
    fn get_secret(&self, service: &str) -> Result<Option<String>>;
    fn delete_secret(&self, service: &str) -> Result<()>;
}
