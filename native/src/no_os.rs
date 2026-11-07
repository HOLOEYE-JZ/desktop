//! Linux: no OS keystore in scope, no Hello, no forced preferences. The same exports,
//! so the surface doesn't depend on the platform.

use std::time::Duration;

use crate::keystore::{DecryptPlan, Found, KeystoreError, PeerKey, SignPlan};

pub fn hello_available() -> bool {
    false
}

pub fn hello_verify(_reason: &str, _hwnd: &[u8], _timeout: Duration) -> &'static str {
    "unavailable"
}

pub fn hello_key_create(_name: &str, _data: &[u8], _hwnd: &[u8], _timeout: Duration) -> crate::HelloKeyOutcome {
    crate::HelloKeyOutcome::word("unavailable")
}

pub fn hello_key_sign(_name: &str, _data: &[u8], _hwnd: &[u8], _timeout: Duration) -> crate::HelloKeyOutcome {
    crate::HelloKeyOutcome::word("unavailable")
}

pub fn hello_key_open(_name: &str) -> &'static str {
    "unavailable"
}

pub fn hello_key_delete(_name: &str) -> &'static str {
    "missing"
}

pub fn hello_key_cancel() {}

pub fn enumerate(_wanted: impl Fn(&[u8]) -> bool) -> Result<Vec<Found>, KeystoreError> {
    Ok(vec![])
}

pub fn sign(_id: &str, _digest: &[u8], _plan: SignPlan, _hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    Err(KeystoreError::Unsupported)
}

pub fn decrypt(_id: &str, _data: &[u8], _plan: &DecryptPlan, _hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    Err(KeystoreError::Unsupported)
}

pub fn agree(_id: &str, _peer: &PeerKey, _hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    Err(KeystoreError::Unsupported)
}

pub fn policy_is_forced(_key: &str) -> bool {
    false
}


/// Windows only.
pub fn window_to_front(_hwnd: &[u8]) -> bool {
    false
}
