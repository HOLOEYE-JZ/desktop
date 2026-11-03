//! The Bulwark desktop app's native helper. Everything exported is in this file and
//! listed in README.md. test/native.spec.ts fails if an export appears that isn't.
//!
//! Key operations run on libuv's pool, since an OS prompt can take a while. The JS
//! wrapper (src/main/native-loader.ts) runs them one at a time, so a PIN dialog holds
//! one pool thread and no more.

// Each OS uses a different part: CNG needs the ECDSA conversion, Linux none of it.
#[cfg_attr(not(windows), allow(dead_code))]
mod der;
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
mod keystore;

#[cfg_attr(windows, path = "windows_os.rs")]
#[cfg_attr(target_os = "macos", path = "macos.rs")]
#[cfg_attr(not(any(windows, target_os = "macos")), path = "no_os.rs")]
mod os;

use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

use keystore::{DecryptPlan, KeystoreError, Listed, PeerKey, SignPlan};

const MAX_REASON: usize = 256;
const MAX_HELLO_TIMEOUT_MS: u32 = 5 * 60_000;
const MAX_POLICY_KEY: usize = 128;

fn thrown(error: KeystoreError) -> Error {
    Error::from_reason(error.to_string())
}

// ─── Hello ───────────────────────────────────────────────────

pub struct HelloAvailableTask;

impl Task for HelloAvailableTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<bool> {
        Ok(os::hello_available())
    }

    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

/// Whether Windows says a Hello prompt can be shown. False on other systems.
#[napi]
pub fn hello_available() -> AsyncTask<HelloAvailableTask> {
    AsyncTask::new(HelloAvailableTask)
}

pub struct HelloVerifyTask {
    reason: String,
    hwnd: Vec<u8>,
    timeout: Duration,
}

impl Task for HelloVerifyTask {
    type Output = &'static str;
    type JsValue = String;

    fn compute(&mut self) -> Result<&'static str> {
        Ok(os::hello_verify(&self.reason, &self.hwnd, self.timeout))
    }

    fn resolve(&mut self, _env: Env, output: &'static str) -> Result<String> {
        Ok(output.to_string())
    }
}

/// Shows the Hello prompt on a window, and answers `verified`, `cancelled`, `busy`,
/// `unavailable`, `timeout`, `invalid` or `failed`. Unlocks nothing by itself. A
/// timeout is required, so no caller can leave a prompt waiting for ever.
#[napi]
pub fn hello_verify(reason: String, hwnd: Buffer, timeout_ms: u32) -> Result<AsyncTask<HelloVerifyTask>> {
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(Error::from_reason("hello: reason must be 1 to 256 characters"));
    }
    if timeout_ms == 0 || timeout_ms > MAX_HELLO_TIMEOUT_MS {
        return Err(Error::from_reason("hello: timeout out of range"));
    }
    Ok(AsyncTask::new(HelloVerifyTask { reason, hwnd: hwnd.to_vec(), timeout: Duration::from_millis(timeout_ms as u64) }))
}

// ─── Keystore ────────────────────────────────────────────────

#[napi(object)]
pub struct KeystoreCertificate {
    /// SHA-256 of the certificate, lowercase hex.
    pub id: String,
    /// DER.
    pub certificate: Buffer,
    /// Intermediates, DER, without leaf and root. May be empty.
    pub chain: Vec<Buffer>,
    pub subject: String,
    pub issuer: String,
    /// Hex of the serial's bytes.
    pub serial: String,
    /// Milliseconds since 1970.
    pub not_before: f64,
    pub not_after: f64,
    /// keyUsage names. Empty if the certificate has no such extension.
    pub usages: Vec<String>,
    /// extendedKeyUsage OIDs. Empty if the certificate has no such extension.
    pub extended_usages: Vec<String>,
    /// The key's algorithm OID.
    pub algorithm: String,
    /// `rsa` or `ec`.
    pub key_type: String,
    pub curve: Option<String>,
    pub key_bits: u32,
    /// `software`, `smartcard`, `keychain` or `unknown`. A hint for the UI.
    pub source: String,
    pub sign_schemes: Vec<String>,
    pub decrypt_schemes: Vec<String>,
    pub can_agree: bool,
    /// The key can also sign the user in somewhere: consent per use, not per session.
    pub ask_each_use: bool,
}

fn to_js(listed: Listed) -> KeystoreCertificate {
    let (key_type, curve, key_bits) = match listed.certificate.key {
        der::KeyKind::Rsa { bits, .. } => ("rsa", None, bits),
        der::KeyKind::Ec { curve } => ("ec", Some(curve.name().to_string()), curve.bits()),
    };
    let usages = listed.certificate.usage_names();
    KeystoreCertificate {
        id: listed.found.id,
        certificate: listed.found.der.into(),
        chain: listed.found.chain.into_iter().map(Buffer::from).collect(),
        subject: listed.certificate.subject,
        issuer: listed.certificate.issuer,
        serial: listed.certificate.serial,
        not_before: listed.certificate.not_before,
        not_after: listed.certificate.not_after,
        usages,
        extended_usages: listed.certificate.extended_key_usage.unwrap_or_default(),
        algorithm: listed.certificate.algorithm,
        key_type: key_type.to_string(),
        curve,
        key_bits,
        source: listed.found.source.to_string(),
        sign_schemes: listed.sign_schemes,
        decrypt_schemes: listed.decrypt_schemes,
        can_agree: listed.can_agree,
        ask_each_use: listed.ask_each_use,
    }
}

pub struct ListTask;

impl Task for ListTask {
    type Output = Vec<Listed>;
    type JsValue = Vec<KeystoreCertificate>;

    fn compute(&mut self) -> Result<Vec<Listed>> {
        Ok(keystore::remember(os::enumerate(keystore::wanted).map_err(thrown)?))
    }

    fn resolve(&mut self, _env: Env, output: Vec<Listed>) -> Result<Vec<KeystoreCertificate>> {
        Ok(output.into_iter().map(to_js).collect())
    }
}

/// Certificates fit for mail that have a private key. Never prompts, and doesn't touch
/// a smart card. The ids it returns are the only ones the calls below accept.
#[napi]
pub fn keystore_list() -> AsyncTask<ListTask> {
    AsyncTask::new(ListTask)
}

type BytesJob = Box<dyn FnOnce() -> std::result::Result<Vec<u8>, KeystoreError> + Send>;

/// Runs off the JS thread and hands back bytes.
pub struct BytesTask {
    run: Option<BytesJob>,
}

impl Task for BytesTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Vec<u8>> {
        match self.run.take() {
            Some(run) => run().map_err(thrown),
            None => Err(thrown(KeystoreError::Failed("ran twice".into()))),
        }
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> Result<Buffer> {
        Ok(output.into())
    }
}

fn bytes_task(run: impl FnOnce() -> std::result::Result<Vec<u8>, KeystoreError> + Send + 'static) -> AsyncTask<BytesTask> {
    AsyncTask::new(BytesTask { run: Some(Box::new(run)) })
}

#[napi(object)]
pub struct SignScheme {
    /// `rsa-pkcs1`, `rsa-pss` (MGF1 with the same hash, salt as long as the hash) or
    /// `ecdsa`.
    pub scheme: String,
    /// `SHA-256`, `SHA-384` or `SHA-512`.
    pub hash: String,
}

/// Signs a digest, not data. RSA gives the raw signature, ECDSA a DER ECDSA-Sig-Value.
#[napi]
pub fn keystore_sign(id: String, digest: Buffer, scheme: SignScheme, hwnd: Option<Buffer>) -> Result<AsyncTask<BytesTask>> {
    let facts = keystore::known(&id).map_err(thrown)?;
    let digest = digest.to_vec();
    let plan: SignPlan = keystore::check_sign(&facts, &digest, &scheme.scheme, &scheme.hash).map_err(thrown)?;
    let hwnd = hwnd.map(|window| window.to_vec());
    Ok(bytes_task(move || os::sign(&id, &digest, plan, hwnd.as_deref())))
}

#[napi(object)]
pub struct DecryptScheme {
    /// `rsa-pkcs1` or `rsa-oaep`.
    pub scheme: String,
    /// For OAEP, with MGF1 on the same hash: `SHA-1`, `SHA-256`, `SHA-384`, `SHA-512`.
    pub hash: Option<String>,
    /// For OAEP.
    pub label: Option<Buffer>,
}

/// Unwraps a CMS content key with RSA. v1.5 answers only with 16, 24 or 32 bytes, OAEP
/// with up to 64, and every failure reads the same.
#[napi]
pub fn keystore_decrypt(id: String, data: Buffer, scheme: DecryptScheme, hwnd: Option<Buffer>) -> Result<AsyncTask<BytesTask>> {
    let facts = keystore::known(&id).map_err(thrown)?;
    let data = data.to_vec();
    let label = scheme.label.as_ref().map(|label| label.to_vec());
    let plan: DecryptPlan =
        keystore::check_decrypt(&facts, &data, &scheme.scheme, scheme.hash.as_deref(), label.as_deref()).map_err(thrown)?;
    let hwnd = hwnd.map(|window| window.to_vec());
    Ok(bytes_task(move || keystore::check_decrypted(os::decrypt(&id, &data, &plan, hwnd.as_deref()), &plan)))
}

/// ECDH: the raw shared secret Z, big-endian, as long as the curve's field, like
/// WebCrypto's deriveBits. The peer's key is an EC SubjectPublicKeyInfo on our curve.
#[napi]
pub fn keystore_agree(id: String, peer_public_key: Buffer, hwnd: Option<Buffer>) -> Result<AsyncTask<BytesTask>> {
    let facts = keystore::known(&id).map_err(thrown)?;
    let peer: PeerKey = keystore::check_agree(&facts, &peer_public_key).map_err(thrown)?;
    let hwnd = hwnd.map(|window| window.to_vec());
    Ok(bytes_task(move || os::agree(&id, &peer, hwnd.as_deref())))
}

// ─── Forced policy ───────────────────────────────────────────

/// macOS: whether a configuration profile forces this preference. False elsewhere.
#[napi]
pub fn policy_is_forced(key: String) -> Result<bool> {
    if key.is_empty() || key.len() > MAX_POLICY_KEY || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
        return Err(Error::from_reason("policy: bad key"));
    }
    Ok(os::policy_is_forced(&key))
}
