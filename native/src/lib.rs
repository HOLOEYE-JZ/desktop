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

#[cfg_attr(windows, path = "files_windows.rs")]
#[cfg_attr(not(windows), path = "files_none.rs")]
mod files;

use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, Buffer, ToNapiValue, TypeName, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Error, Result, Status, Task};
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

// ─── Files drive (Windows Cloud Files) ───────────────────────
//
// Main decides what to place and fetch, and checks every path against its root first. These
// check what they're given anyway: lengths, absolute paths, names without separators.

const MAX_PATH_CHARS: usize = 32_767;
const MAX_NAME_CHARS: usize = 255;
const MAX_IDENTITY_BYTES: usize = 4096;
const MAX_TRANSFER_BYTES: usize = 64 * 1024 * 1024;
const MAX_PLACE_BATCH: usize = 4096;
/// The largest integer a JS number holds exactly.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn files_error(message: String) -> Error {
    Error::from_reason(message)
}

fn invalid(what: &str) -> Error {
    Error::from_reason(format!("files:invalid ({what})"))
}

fn checked_path(path: &str) -> Result<&str> {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    if !drive || path.chars().count() > MAX_PATH_CHARS || path.contains('\0') || path.contains('/') {
        return Err(invalid("path"));
    }
    Ok(path)
}

fn checked_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name == "." || name == ".." || name.chars().any(|c| c == '\\' || c == '/' || c == '\0') {
        return Err(invalid("name"));
    }
    Ok(name)
}

fn checked_identity(identity: &str) -> Result<&str> {
    if identity.is_empty() || identity.len() > MAX_IDENTITY_BYTES {
        return Err(invalid("identity"));
    }
    Ok(identity)
}

fn checked_count(value: f64, what: &str) -> Result<i64> {
    if !value.is_finite() || !(0.0..=MAX_SAFE).contains(&value) || value.fract() != 0.0 {
        return Err(invalid(what));
    }
    Ok(value as i64)
}

fn checked_key(key: &str) -> Result<i64> {
    key.parse::<i64>().map_err(|_| invalid("key"))
}

fn checked_label(value: &str, max: usize, what: &str, allowed: impl Fn(char) -> bool) -> Result<()> {
    if value.is_empty() || value.chars().count() > max || !value.chars().all(allowed) {
        return Err(invalid(what));
    }
    Ok(())
}

type FilesJobRun<T> = Box<dyn FnOnce() -> std::result::Result<T, String> + Send>;

/// A files call off the JS thread.
pub struct FilesJob<T: Send + 'static> {
    run: Option<FilesJobRun<T>>,
}

impl<T: Send + ToNapiValue + TypeName + 'static> Task for FilesJob<T> {
    type Output = T;
    type JsValue = T;

    fn compute(&mut self) -> Result<T> {
        match self.run.take() {
            Some(run) => run().map_err(files_error),
            None => Err(Error::from_reason("files:failed (ran twice)")),
        }
    }

    fn resolve(&mut self, _env: Env, output: T) -> Result<T> {
        Ok(output)
    }
}

fn files_job<T: Send + ToNapiValue + TypeName + 'static>(run: impl FnOnce() -> std::result::Result<T, String> + Send + 'static) -> AsyncTask<FilesJob<T>> {
    AsyncTask::new(FilesJob { run: Some(Box::new(run)) })
}

#[napi(object)]
pub struct FilesRegistration {
    /// The provider part of the id: `Bulwark`, or `Bulwark Test <pid>` in tests.
    pub provider: String,
    /// The account part of the id: a hash main makes, never an address.
    pub account: String,
    /// The folder, absolute. It must exist.
    pub path: String,
    pub display_name: String,
    /// `<file>,<index>` as Explorer reads icons.
    pub icon: String,
    pub version: String,
}

#[napi(object)]
pub struct FilesSyncRoot {
    pub id: String,
    pub path: String,
    pub display_name: String,
}

#[napi(object)]
pub struct FilesFetchEvent {
    /// `fetch` or `cancel`.
    pub kind: String,
    pub connection: String,
    pub transfer_key: String,
    pub request_key: String,
    /// The file's absolute path.
    pub path: String,
    pub identity: String,
    pub offset: f64,
    pub length: f64,
    pub total: f64,
    /// The process that opened it, 0 if Windows didn't say.
    pub pid: u32,
}

#[napi(object)]
pub struct FilesPlacement {
    /// One name, no separators: placed in the parent the call names.
    pub name: String,
    pub directory: bool,
    pub size: f64,
    pub mtime_ms: f64,
    pub identity: String,
}

#[napi(object)]
pub struct FilesPlaceholderInfo {
    pub placeholder: bool,
    pub directory: bool,
    pub identity: Option<String>,
    pub in_sync: bool,
    /// All of its content is on disk.
    pub hydrated: bool,
    /// Some of it is.
    pub partial: bool,
    /// `pinned`, `unpinned` or `unspecified`.
    pub pin: String,
    pub size: f64,
    pub on_disk: f64,
}

#[napi(object)]
pub struct FilesUpdate {
    pub size: Option<f64>,
    pub mtime_ms: Option<f64>,
    pub identity: Option<String>,
    pub mark_in_sync: bool,
    pub dehydrate: bool,
    /// Refuse (`files:changed`) if it isn't in sync now: someone changed it here.
    pub verify_in_sync: bool,
}

/// Registers a sync root with Windows, so Explorer shows it. Answers its id,
/// `<provider>!<user SID>!<account>`. Registering an id again updates it.
#[napi]
pub fn files_drive_register(options: FilesRegistration) -> Result<AsyncTask<FilesJob<String>>> {
    checked_label(&options.provider, 64, "provider", |c| c.is_ascii_alphanumeric() || " ._-".contains(c))?;
    checked_label(&options.account, 64, "account", |c| c.is_ascii_alphanumeric() || "_-".contains(c))?;
    checked_label(&options.display_name, 256, "display name", |c| !c.is_control())?;
    checked_label(&options.icon, 1024, "icon", |c| !c.is_control())?;
    checked_label(&options.version, 64, "version", |c| c.is_ascii_alphanumeric() || ".-+".contains(c))?;
    checked_path(&options.path)?;
    Ok(files_job(move || files::register(&options)))
}

#[napi]
pub fn files_drive_unregister(id: String) -> Result<AsyncTask<FilesJob<()>>> {
    checked_label(&id, 512, "id", |c| !c.is_control())?;
    Ok(files_job(move || files::unregister(&id)))
}

/// This user's sync roots, every provider's: main and the cleanup pick theirs by id.
#[napi]
pub fn files_drive_roots() -> AsyncTask<FilesJob<Vec<FilesSyncRoot>>> {
    files_job(files::roots)
}

type FetchCallback = ThreadsafeFunction<FilesFetchEvent, Unknown<'static>, FilesFetchEvent, Status, false, true>;

/// Connects to a registered sync root. Windows' FETCH_DATA and CANCEL_FETCH_DATA come to
/// `callback`, on the JS thread. Answers the connection key.
#[napi]
pub fn files_drive_connect(path: String, callback: FetchCallback) -> Result<String> {
    checked_path(&path)?;
    let sink: files::Sink = Box::new(move |event| callback.call(event, ThreadsafeFunctionCallMode::NonBlocking) == Status::Ok);
    files::connect(&path, sink).map_err(files_error)
}

#[napi]
pub fn files_drive_disconnect(connection: String) -> Result<()> {
    files::disconnect(checked_key(&connection)?).map_err(files_error)
}

/// Bytes for a fetch: from a 4 KB aligned offset, a multiple of 4 KB long unless they end
/// the file.
#[napi]
pub fn files_drive_transfer(connection: String, transfer_key: String, request_key: String, offset: f64, data: Buffer) -> Result<AsyncTask<FilesJob<()>>> {
    let (connection, transfer_key, request_key) = (checked_key(&connection)?, checked_key(&transfer_key)?, checked_key(&request_key)?);
    let offset = checked_count(offset, "offset")?;
    if offset % 4096 != 0 || data.is_empty() || data.len() > MAX_TRANSFER_BYTES {
        return Err(invalid("transfer"));
    }
    let data = data.to_vec();
    Ok(files_job(move || files::transfer(connection, transfer_key, request_key, offset, &data)))
}

/// Ends a fetch with an error: `offline`, `denied`, `timeout`, `not-running` or `failed`.
#[napi]
pub fn files_drive_transfer_failed(connection: String, transfer_key: String, request_key: String, offset: f64, length: f64, reason: String) -> Result<()> {
    let (connection, transfer_key, request_key) = (checked_key(&connection)?, checked_key(&transfer_key)?, checked_key(&request_key)?);
    let (offset, length) = (checked_count(offset, "offset")?, checked_count(length, "length")?);
    if !["offline", "denied", "timeout", "not-running", "failed"].contains(&reason.as_str()) {
        return Err(invalid("reason"));
    }
    files::transfer_failed(connection, transfer_key, request_key, offset, length, &reason).map_err(files_error)
}

/// Placeholders in one folder, in sync, with nothing fetched. One answer per entry: `""` for
/// placed, else a code (`exists`, `name`, ...).
#[napi]
pub fn files_drive_place(parent: String, entries: Vec<FilesPlacement>) -> Result<Vec<String>> {
    checked_path(&parent)?;
    if entries.len() > MAX_PLACE_BATCH {
        return Err(invalid("batch"));
    }
    for entry in &entries {
        checked_name(&entry.name)?;
        checked_identity(&entry.identity)?;
        checked_count(entry.size, "size")?;
        if !entry.mtime_ms.is_finite() {
            return Err(invalid("mtime"));
        }
    }
    files::place(&parent, &entries).map_err(files_error)
}

/// What a path under a sync root is now. Fetches nothing.
#[napi]
pub fn files_drive_info(path: String) -> Result<FilesPlaceholderInfo> {
    files::info(checked_path(&path)?).map_err(files_error)
}

#[napi]
pub fn files_drive_update(path: String, change: FilesUpdate) -> Result<()> {
    checked_path(&path)?;
    if let Some(identity) = &change.identity {
        checked_identity(identity)?;
    }
    if let Some(size) = change.size {
        checked_count(size, "size")?;
    }
    if change.mtime_ms.is_some_and(|ms| !ms.is_finite()) {
        return Err(invalid("mtime"));
    }
    files::update(&path, &change).map_err(files_error)
}

/// Makes something created here a placeholder with this identity, in sync.
#[napi]
pub fn files_drive_convert(path: String, identity: String) -> Result<()> {
    files::convert(checked_path(&path)?, checked_identity(&identity)?).map_err(files_error)
}

/// Fetches all of a file, through this process's own connection. Resolves when it's on disk.
#[napi]
pub fn files_drive_hydrate(path: String) -> Result<AsyncTask<FilesJob<()>>> {
    checked_path(&path)?;
    Ok(files_job(move || files::hydrate(&path)))
}

/// Drops a file's content from the disk. Refused (`files:pinned`) for a pinned one.
#[napi]
pub fn files_drive_dehydrate(path: String) -> Result<()> {
    files::dehydrate(checked_path(&path)?).map_err(files_error)
}

/// Drive letters in use now, A as bit 0. For picking a free one for the drive.
#[napi]
pub fn files_used_drive_letters() -> u32 {
    files::used_drive_letters()
}
