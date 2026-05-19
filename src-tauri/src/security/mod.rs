//! Secret storage. API keys live in the OS keyring (Windows Credential
//! Manager, macOS Keychain, libsecret on Linux) instead of plaintext SQLite.
//!
//! The keyring crate's per-OS native backends are user-scoped and encrypted
//! at rest by the platform. A failure on any backend (missing libsecret,
//! locked keychain, headless Linux session) falls back to a `MemoryStore`
//! so the app keeps working — diagnostics surface in the log.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "com.vibeprompter.app";

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
    /// Display name used in the About panel so the user can see whether
    /// their keys are in the OS keyring or the volatile fallback.
    #[allow(dead_code)]
    fn backend(&self) -> &'static str;
}

pub struct KeyringStore;

impl KeyringStore {
    pub fn new() -> Self {
        Self
    }

    /// Probe the keyring by round-tripping a sentinel credential. We do NOT
    /// cache the result — transient backend issues should self-heal between
    /// launches.
    pub fn is_available(&self) -> bool {
        let entry = match keyring::Entry::new(SERVICE, "__healthcheck") {
            Ok(e) => e,
            Err(_) => return false,
        };
        if entry.set_password("ok").is_err() {
            return false;
        }
        let ok = entry.get_password().ok().as_deref() == Some("ok");
        let _ = entry.delete_credential();
        ok
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, account)
            .ok()
            .and_then(|e| e.get_password().ok())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn backend(&self) -> &'static str {
        "OS keyring"
    }
}

pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Option<String> {
        self.map.lock().unwrap().get(account).cloned()
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.map.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.map.lock().unwrap().remove(account);
        Ok(())
    }
    fn backend(&self) -> &'static str {
        "in-memory (keyring unavailable)"
    }
}

pub fn init() -> Box<dyn SecretStore> {
    let keyring = KeyringStore::new();
    if keyring.is_available() {
        tracing::info!("secret store: OS keyring");
        Box::new(keyring)
    } else {
        tracing::warn!(
            "secret store: OS keyring unavailable — falling back to volatile memory. \
             API keys will need to be re-entered after restart."
        );
        Box::new(MemoryStore::new())
    }
}

pub fn connection_account(id: &str) -> String {
    format!("connection:{id}")
}
