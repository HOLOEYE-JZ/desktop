//! Windows: Hello through UserConsentVerifier, keys through CNG. Listing never
//! prompts and doesn't touch a smart card. Key operations run without the silent
//! flag, so the OS and the card's own PIN dialogs show as they always do.

use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::core::{factory, Error as WinError, HSTRING, PCWSTR};
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Security::Cryptography::*;
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindow, IsWindow, PostMessageW, GW_OWNER, WM_CLOSE};
use windows_future::{AsyncStatus, IAsyncOperation};

use crate::der::Curve;
use crate::keystore::{DecryptPlan, Found, Hash, KeyAllows, KeystoreError, PeerKey, SignPlan};

// ─── Hello ───────────────────────────────────────────────────

const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(50);

/// Waits for an operation, or gives up and cancels it. The prompt must never be able
/// to hold a thread forever.
fn wait<T>(op: &IAsyncOperation<T>, timeout: Duration) -> Result<Option<T>, WinError>
where
    T: windows_core::RuntimeType + 'static,
{
    let deadline = Instant::now() + timeout;
    loop {
        match op.Status()? {
            AsyncStatus::Started => {
                if Instant::now() >= deadline {
                    let _ = op.Cancel();
                    return Ok(None);
                }
                sleep(POLL);
            }
            AsyncStatus::Completed => return op.GetResults().map(Some),
            AsyncStatus::Canceled => return Ok(None),
            _ => return Err(op.ErrorCode()?.into()),
        }
    }
}

pub fn hello_available() -> bool {
    let answer = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| wait(&op, AVAILABILITY_TIMEOUT));
    matches!(answer, Ok(Some(UserConsentVerifierAvailability::Available)))
}

/// A window handle as Electron's getNativeWindowHandle gives it: the pointer's bytes.
fn window_from(bytes: &[u8]) -> Option<HWND> {
    let value = match bytes.len() {
        8 => u64::from_le_bytes(bytes.try_into().ok()?) as usize,
        4 => u32::from_le_bytes(bytes.try_into().ok()?) as usize,
        _ => return None,
    };
    let window = HWND(value as *mut core::ffi::c_void);
    unsafe { IsWindow(Some(window)) }.as_bool().then_some(window)
}

/// The Windows Security dialog's window class. Not documented, so if a later Windows
/// renames it a timed-out prompt just stays open until the user closes it.
const DIALOG_CLASS: &str = "Credential Dialog Xaml Host";

unsafe extern "system" fn collect_dialog(window: HWND, list: LPARAM) -> windows::core::BOOL {
    let list = &mut *(list.0 as *mut Vec<isize>);
    let mut name = [0u16; 64];
    let length = GetClassNameW(window, &mut name) as usize;
    if String::from_utf16_lossy(&name[..length]) == DIALOG_CLASS {
        list.push(window.0 as isize);
    }
    windows::core::BOOL(1)
}

fn dialog_windows() -> Vec<isize> {
    let mut list: Vec<isize> = Vec::new();
    let _ = unsafe { EnumWindows(Some(collect_dialog), LPARAM(&mut list as *mut Vec<isize> as isize)) };
    list
}

/// Cancelling the operation doesn't close the dialog: seen on Windows 11 25H2, where
/// it stayed up with the PIN box after the operation had ended. So the dialogs that
/// weren't there before this prompt get a close message. Another app's dialog that
/// opened meanwhile is told apart by its owner, where it has one.
fn close_new_dialogs(before: &[isize], ours: HWND) {
    for handle in dialog_windows() {
        if before.contains(&handle) {
            continue;
        }
        let dialog = HWND(handle as *mut core::ffi::c_void);
        if let Ok(owner) = unsafe { GetWindow(dialog, GW_OWNER) } {
            if !owner.is_invalid() && owner != ours {
                continue;
            }
        }
        let _ = unsafe { PostMessageW(Some(dialog), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    }
}

/// Yes or no with a reason for the no. Unlocks nothing by itself: it gates the UI.
pub fn hello_verify(reason: &str, hwnd: &[u8], timeout: Duration) -> &'static str {
    let Some(window) = window_from(hwnd) else { return "invalid" };
    if !hello_available() {
        return "unavailable";
    }
    let before = dialog_windows();
    let run = || -> Result<Option<UserConsentVerificationResult>, WinError> {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        let op: IAsyncOperation<UserConsentVerificationResult> =
            unsafe { interop.RequestVerificationForWindowAsync(window, &HSTRING::from(reason)) }?;
        wait(&op, timeout)
    };
    match run() {
        Ok(None) => {
            close_new_dialogs(&before, window);
            "timeout"
        }
        Ok(Some(UserConsentVerificationResult::Verified)) => "verified",
        Ok(Some(UserConsentVerificationResult::Canceled)) => "cancelled",
        Ok(Some(UserConsentVerificationResult::DeviceBusy)) => "busy",
        Ok(Some(
            UserConsentVerificationResult::DeviceNotPresent
            | UserConsentVerificationResult::NotConfiguredForUser
            | UserConsentVerificationResult::DisabledByPolicy,
        )) => "unavailable",
        Ok(Some(_)) | Err(_) => "failed",
    }
}

// ─── Errors ──────────────────────────────────────────────────

const NTE_BAD_KEYSET: u32 = 0x8009_0016;
const NTE_NOT_FOUND: u32 = 0x8009_0011;
const NTE_NO_KEY: u32 = 0x8009_000D;
const NTE_PERM: u32 = 0x8009_0010;
const NTE_NOT_SUPPORTED: u32 = 0x8009_0029;
const NTE_BAD_ALGID: u32 = 0x8009_0008;
const NTE_BAD_FLAGS: u32 = 0x8009_0009;
const NTE_BAD_KEY_STATE: u32 = 0x8009_000B;
const NTE_BAD_TYPE: u32 = 0x8009_000A;
const NTE_INVALID_HANDLE: u32 = 0x8009_0026;
const NTE_USER_CANCELLED: u32 = 0x8009_0036;
const NTE_SILENT_CONTEXT: u32 = 0x8009_0022;
const CRYPT_E_NO_KEY_PROPERTY: u32 = 0x8009_200B;
const CRYPT_E_NOT_FOUND: u32 = 0x8009_2004;
const ERROR_CANCELLED: u32 = 0x8007_04C7;
const ERROR_FILE_NOT_FOUND: u32 = 0x8007_0002;
const SCARD_E_CANCELLED: u32 = 0x8010_0002;
const SCARD_E_NO_SMARTCARD: u32 = 0x8010_000C;
const SCARD_E_NO_READERS: u32 = 0x8010_002E;
const SCARD_W_REMOVED_CARD: u32 = 0x8010_0069;
const SCARD_W_WRONG_CHV: u32 = 0x8010_006B;
const SCARD_W_CHV_BLOCKED: u32 = 0x8010_006C;
const SCARD_W_CANCELLED_BY_USER: u32 = 0x8010_006E;
const SCARD_W_CARD_NOT_AUTHENTICATED: u32 = 0x8010_006F;
const SCARD_E_UNSUPPORTED_FEATURE: u32 = 0x8010_0022;

fn map_error(error: &WinError) -> KeystoreError {
    let code = error.code().0 as u32;
    match code {
        NTE_USER_CANCELLED | ERROR_CANCELLED | SCARD_E_CANCELLED | SCARD_W_CANCELLED_BY_USER => KeystoreError::Cancelled,
        NTE_BAD_KEYSET | NTE_NOT_FOUND | NTE_NO_KEY | CRYPT_E_NO_KEY_PROPERTY | CRYPT_E_NOT_FOUND | ERROR_FILE_NOT_FOUND => {
            KeystoreError::NotFound
        }
        NTE_NOT_SUPPORTED | NTE_BAD_ALGID | NTE_BAD_FLAGS | NTE_BAD_TYPE | NTE_PERM | NTE_BAD_KEY_STATE | SCARD_E_UNSUPPORTED_FEATURE => {
            KeystoreError::Unsupported
        }
        NTE_SILENT_CONTEXT | SCARD_E_NO_SMARTCARD | SCARD_E_NO_READERS | SCARD_W_REMOVED_CARD | SCARD_W_WRONG_CHV
        | SCARD_W_CHV_BLOCKED | SCARD_W_CARD_NOT_AUTHENTICATED => KeystoreError::Locked,
        NTE_INVALID_HANDLE => KeystoreError::Failed("the key's handle went away".into()),
        _ => KeystoreError::Failed(format!("0x{code:08x}")),
    }
}

// ─── Handles ─────────────────────────────────────────────────

struct Store(HCERTSTORE);

impl Store {
    /// CurrentUser\My, read-only. Smart card certificates land here too, through the
    /// certificate propagation service.
    fn open() -> Result<Store, KeystoreError> {
        let flags = CERT_OPEN_STORE_FLAGS(CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG.0 | CERT_STORE_OPEN_EXISTING_FLAG.0);
        let name = HSTRING::from("MY");
        unsafe { CertOpenStore(CERT_STORE_PROV_SYSTEM_W, CERT_QUERY_ENCODING_TYPE(0), None, flags, Some(name.as_ptr() as *const _)) }
            .map(Store)
            .map_err(|error| map_error(&error))
    }

    fn certificates(&self) -> Certificates<'_> {
        Certificates { store: self, current: std::ptr::null_mut() }
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let _ = unsafe { CertCloseStore(Some(self.0), 0) };
    }
}

struct Certificates<'a> {
    store: &'a Store,
    current: *mut CERT_CONTEXT,
}

impl Certificates<'_> {
    /// CertFindCertificateInStore frees the previous context itself.
    fn next(&mut self) -> Option<*const CERT_CONTEXT> {
        let encoding = CERT_QUERY_ENCODING_TYPE(X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0);
        let previous = (!self.current.is_null()).then_some(self.current as *const CERT_CONTEXT);
        self.current = unsafe { CertFindCertificateInStore(self.store.0, encoding, 0, CERT_FIND_ANY, None, previous) };
        (!self.current.is_null()).then_some(self.current as *const CERT_CONTEXT)
    }
}

impl Drop for Certificates<'_> {
    fn drop(&mut self) {
        if !self.current.is_null() {
            let _ = unsafe { CertFreeCertificateContext(Some(self.current as *const CERT_CONTEXT)) };
        }
    }
}

struct KeyHandle {
    handle: NCRYPT_KEY_HANDLE,
    owned: bool,
}

impl Drop for KeyHandle {
    fn drop(&mut self) {
        if self.owned {
            let _ = unsafe { NCryptFreeObject(NCRYPT_HANDLE(self.handle.0)) };
        }
    }
}

/// A plain NCrypt handle that frees itself: a provider, public key or secret.
struct Object(usize);

impl Drop for Object {
    fn drop(&mut self) {
        if self.0 != 0 {
            let _ = unsafe { NCryptFreeObject(NCRYPT_HANDLE(self.0)) };
        }
    }
}

fn acquire(certificate: *const CERT_CONTEXT, flags: CRYPT_ACQUIRE_FLAGS, window: Option<&HWND>) -> Result<KeyHandle, WinError> {
    let mut handle = HCRYPTPROV_OR_NCRYPT_KEY_HANDLE::default();
    let mut spec = CERT_KEY_SPEC(0);
    let mut owned = windows::core::BOOL(0);
    let (flags, parameter) = match window {
        Some(window) => (CRYPT_ACQUIRE_FLAGS(flags.0 | CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG.0), Some(window as *const HWND as *const core::ffi::c_void)),
        None => (flags, None),
    };
    unsafe {
        CryptAcquireCertificatePrivateKey(certificate, flags, parameter, &mut handle, Some(&mut spec), Some(&mut owned))?;
    }
    Ok(KeyHandle { handle: NCRYPT_KEY_HANDLE(handle.0), owned: owned.as_bool() })
}

fn sha256_id(certificate: *const CERT_CONTEXT) -> Option<String> {
    let mut hash = [0u8; 32];
    let mut size = hash.len() as u32;
    unsafe { CertGetCertificateContextProperty(certificate, CERT_SHA256_HASH_PROP_ID, Some(hash.as_mut_ptr() as *mut _), &mut size) }.ok()?;
    (size == 32).then(|| hash.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn der_of(certificate: *const CERT_CONTEXT) -> Vec<u8> {
    unsafe {
        let context = &*certificate;
        std::slice::from_raw_parts(context.pbCertEncoded, context.cbCertEncoded as usize).to_vec()
    }
}

/// The provider's name, if the certificate says it has a private key. Reading this
/// property touches no key and no card.
fn provider_of(certificate: *const CERT_CONTEXT) -> Option<String> {
    let mut size = 0u32;
    unsafe { CertGetCertificateContextProperty(certificate, CERT_KEY_PROV_INFO_PROP_ID, None, &mut size) }.ok()?;
    if (size as usize) < std::mem::size_of::<CRYPT_KEY_PROV_INFO>() {
        return None;
    }
    // u64s: the structure holds pointers, and must be aligned for them.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    unsafe { CertGetCertificateContextProperty(certificate, CERT_KEY_PROV_INFO_PROP_ID, Some(buffer.as_mut_ptr() as *mut _), &mut size) }.ok()?;
    let info = unsafe { &*(buffer.as_ptr() as *const CRYPT_KEY_PROV_INFO) };
    if info.pwszProvName.is_null() {
        return Some(String::new());
    }
    unsafe { info.pwszProvName.to_string() }.ok()
}

/// The chain the store can build on its own: no AIA fetch, so listing makes no
/// network requests. Intermediates only, leaf and root left out.
fn chain_of(certificate: *const CERT_CONTEXT) -> Vec<Vec<u8>> {
    let mut parameters = CERT_CHAIN_PARA { cbSize: std::mem::size_of::<CERT_CHAIN_PARA>() as u32, ..Default::default() };
    parameters.RequestedUsage.dwType = 0;
    let mut context: *mut CERT_CHAIN_CONTEXT = std::ptr::null_mut();
    let built = unsafe {
        CertGetCertificateChain(None, certificate, None, None, &parameters, CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL, None, &mut context)
    };
    if built.is_err() || context.is_null() {
        return vec![];
    }
    let mut out = Vec::new();
    unsafe {
        let chains = &*context;
        if chains.cChain > 0 {
            let simple = &**chains.rgpChain;
            for index in 1..simple.cElement as usize {
                let element = &**simple.rgpElement.add(index);
                if element.TrustStatus.dwInfoStatus & CERT_TRUST_IS_SELF_SIGNED != 0 {
                    continue;
                }
                out.push(der_of(element.pCertContext));
            }
        }
        CertFreeCertificateChain(context);
    }
    out
}

fn key_usage_of(key: &KeyHandle) -> Option<KeyAllows> {
    let mut bytes = [0u8; 4];
    let mut size = 0u32;
    let got = unsafe {
        NCryptGetProperty(NCRYPT_HANDLE(key.handle.0), NCRYPT_KEY_USAGE_PROPERTY, Some(&mut bytes), &mut size, windows::Win32::Security::OBJECT_SECURITY_INFORMATION(NCRYPT_SILENT_FLAG.0))
    };
    if got.is_err() || size != 4 {
        return None;
    }
    let usage = u32::from_le_bytes(bytes);
    // Only an ECDH key agrees and only an ECDSA key signs, whatever the usage bits say.
    // New-SelfSignedCertificate, for one, makes plain ECDSA keys that claim both.
    let ecdh = algorithm_of(key)?.starts_with("ECDH");
    Some(KeyAllows {
        sign: usage & NCRYPT_ALLOW_SIGNING_FLAG != 0 && !ecdh,
        decrypt: usage & NCRYPT_ALLOW_DECRYPT_FLAG != 0,
        agree: usage & NCRYPT_ALLOW_KEY_AGREEMENT_FLAG != 0 && ecdh,
    })
}

// ─── Keystore ────────────────────────────────────────────────

pub fn enumerate(wanted: impl Fn(&[u8]) -> bool) -> Result<Vec<Found>, KeystoreError> {
    let store = Store::open()?;
    let mut certificates = store.certificates();
    let mut out = Vec::new();
    while let Some(certificate) = certificates.next() {
        let Some(provider) = provider_of(certificate) else { continue };
        let der = der_of(certificate);
        if !wanted(&der) {
            continue;
        }
        let Some(id) = sha256_id(certificate) else { continue };
        let smartcard = provider.to_ascii_lowercase().contains("smart card");
        let mut allows = None;
        // A card stays untouched while listing. A software key is checked silently:
        // the certificate can outlive its key, and then it isn't a key we have.
        if !smartcard {
            let flags = CRYPT_ACQUIRE_FLAGS(CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG.0 | CRYPT_ACQUIRE_SILENT_FLAG.0);
            match acquire(certificate, flags, None) {
                Ok(key) => allows = key_usage_of(&key),
                Err(error) if map_error(&error) == KeystoreError::NotFound => continue,
                Err(_) => {}
            }
        }
        let source = if smartcard {
            "smartcard"
        } else if provider.contains("Software") || provider.contains("Cryptographic Provider") {
            "software"
        } else {
            "unknown"
        };
        out.push(Found { id, der, chain: chain_of(certificate), source, allows });
    }
    Ok(out)
}

/// The key of a listed certificate, with whatever prompts the OS wants to show.
fn open_key(id: &str, hwnd: Option<&[u8]>) -> Result<KeyHandle, KeystoreError> {
    let store = Store::open()?;
    let mut certificates = store.certificates();
    let window = hwnd.and_then(window_from);
    while let Some(certificate) = certificates.next() {
        if sha256_id(certificate).as_deref() != Some(id) {
            continue;
        }
        let key = acquire(certificate, CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG, window.as_ref()).map_err(|error| map_error(&error))?;
        if let Some(window) = window {
            // So a card's PIN dialog opens on top of our window. It works without this.
            let value = (window.0 as usize).to_ne_bytes();
            let _ = unsafe { NCryptSetProperty(NCRYPT_HANDLE(key.handle.0), NCRYPT_WINDOW_HANDLE_PROPERTY, &value, NCRYPT_FLAGS(0)) };
        }
        return Ok(key);
    }
    Err(KeystoreError::NotFound)
}

fn algorithm_id(hash: Hash) -> PCWSTR {
    match hash {
        Hash::Sha1 => BCRYPT_SHA1_ALGORITHM,
        Hash::Sha256 => BCRYPT_SHA256_ALGORITHM,
        Hash::Sha384 => BCRYPT_SHA384_ALGORITHM,
        Hash::Sha512 => BCRYPT_SHA512_ALGORITHM,
    }
}

pub fn sign(id: &str, digest: &[u8], plan: SignPlan, hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    let key = open_key(id, hwnd)?;
    let pkcs1;
    let pss;
    let (padding, flags): (Option<*const core::ffi::c_void>, NCRYPT_FLAGS) = match plan {
        SignPlan::RsaPkcs1(hash) => {
            pkcs1 = BCRYPT_PKCS1_PADDING_INFO { pszAlgId: algorithm_id(hash) };
            (Some(&pkcs1 as *const _ as *const _), NCRYPT_PAD_PKCS1_FLAG)
        }
        SignPlan::RsaPss(hash) => {
            pss = BCRYPT_PSS_PADDING_INFO { pszAlgId: algorithm_id(hash), cbSalt: hash.length() as u32 };
            (Some(&pss as *const _ as *const _), NCRYPT_PAD_PSS_FLAG)
        }
        SignPlan::Ecdsa => (None, NCRYPT_FLAGS(0)),
    };
    let mut size = 0u32;
    unsafe { NCryptSignHash(key.handle, padding, digest, None, &mut size, flags) }.map_err(|error| map_error(&error))?;
    let mut signature = vec![0u8; size as usize];
    unsafe { NCryptSignHash(key.handle, padding, digest, Some(&mut signature), &mut size, flags) }.map_err(|error| map_error(&error))?;
    signature.truncate(size as usize);
    match plan {
        // CNG gives r||s, CMS wants DER.
        SignPlan::Ecdsa => crate::der::ecdsa_raw_to_der(&signature).ok_or_else(|| KeystoreError::Failed("odd ECDSA signature".into())),
        _ => Ok(signature),
    }
}

pub fn decrypt(id: &str, data: &[u8], plan: &DecryptPlan, hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    let key = open_key(id, hwnd)?;
    let oaep;
    let (padding, flags): (Option<*const core::ffi::c_void>, NCRYPT_FLAGS) = match plan {
        DecryptPlan::RsaPkcs1 => (None, NCRYPT_PAD_PKCS1_FLAG),
        DecryptPlan::RsaOaep { hash, label } => {
            oaep = BCRYPT_OAEP_PADDING_INFO {
                pszAlgId: algorithm_id(*hash),
                pbLabel: label.as_ref().map_or(std::ptr::null_mut(), |label| label.as_ptr() as *mut u8),
                cbLabel: label.as_ref().map_or(0, |label| label.len() as u32),
            };
            (Some(&oaep as *const _ as *const _), NCRYPT_PAD_OAEP_FLAG)
        }
    };
    let mut size = 0u32;
    unsafe { NCryptDecrypt(key.handle, Some(data), padding, None, &mut size, flags) }.map_err(|error| map_error(&error))?;
    let mut plain = vec![0u8; size as usize];
    unsafe { NCryptDecrypt(key.handle, Some(data), padding, Some(&mut plain), &mut size, flags) }.map_err(|error| map_error(&error))?;
    plain.truncate(size as usize);
    Ok(plain)
}

fn public_magic(curve: Curve) -> u32 {
    match curve {
        Curve::P256 => BCRYPT_ECDH_PUBLIC_P256_MAGIC,
        Curve::P384 => BCRYPT_ECDH_PUBLIC_P384_MAGIC,
        Curve::P521 => BCRYPT_ECDH_PUBLIC_P521_MAGIC,
    }
}

/// The key's CNG algorithm: `RSA`, `ECDSA_P256`, `ECDH_P256`, plain `ECDSA`.
fn algorithm_of(key: &KeyHandle) -> Option<String> {
    let mut bytes = [0u8; 64];
    let mut size = 0u32;
    unsafe {
        NCryptGetProperty(
            NCRYPT_HANDLE(key.handle.0),
            NCRYPT_ALGORITHM_PROPERTY,
            Some(&mut bytes),
            &mut size,
            windows::Win32::Security::OBJECT_SECURITY_INFORMATION(0),
        )
    }
    .ok()?;
    let units: Vec<u16> = bytes[..size as usize].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).take_while(|unit| *unit != 0).collect();
    Some(String::from_utf16_lossy(&units))
}

/// NCrypt can only agree with a public key held by the same provider, which a card's
/// provider may refuse to import: that comes back as unsupported.
pub fn agree(id: &str, peer: &PeerKey, hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    let key = open_key(id, hwnd)?;
    let failed = |error: WinError| map_error(&error);

    let mut provider_bytes = [0u8; std::mem::size_of::<usize>()];
    let mut size = 0u32;
    unsafe {
        NCryptGetProperty(
            NCRYPT_HANDLE(key.handle.0),
            NCRYPT_PROVIDER_HANDLE_PROPERTY,
            Some(&mut provider_bytes),
            &mut size,
            windows::Win32::Security::OBJECT_SECURITY_INFORMATION(0),
        )
    }
    .map_err(failed)?;
    let provider = Object(usize::from_ne_bytes(provider_bytes));

    let field = peer.curve.field_size();
    let mut blob = Vec::with_capacity(8 + 2 * field);
    blob.extend_from_slice(&public_magic(peer.curve).to_le_bytes());
    blob.extend_from_slice(&(field as u32).to_le_bytes());
    blob.extend_from_slice(&peer.x);
    blob.extend_from_slice(&peer.y);

    let mut public_key = NCRYPT_KEY_HANDLE::default();
    unsafe { NCryptImportKey(NCRYPT_PROV_HANDLE(provider.0), None, BCRYPT_ECCPUBLIC_BLOB, None, &mut public_key, &blob, NCRYPT_FLAGS(0)) }
        .map_err(|error| match map_error(&error) {
            KeystoreError::Failed(detail) if detail.contains("0x80090027") => KeystoreError::Invalid("peer key"),
            other => other,
        })?;
    let public_key = Object(public_key.0);

    let mut secret = NCRYPT_SECRET_HANDLE::default();
    unsafe { NCryptSecretAgreement(key.handle, NCRYPT_KEY_HANDLE(public_key.0), &mut secret, NCRYPT_FLAGS(0)) }.map_err(failed)?;
    let secret = Object(secret.0);
    let secret_handle = NCRYPT_SECRET_HANDLE(secret.0);

    let mut size = 0u32;
    unsafe { NCryptDeriveKey(secret_handle, BCRYPT_KDF_RAW_SECRET, None, None, &mut size, 0) }.map_err(failed)?;
    let mut raw = vec![0u8; size as usize];
    unsafe { NCryptDeriveKey(secret_handle, BCRYPT_KDF_RAW_SECRET, None, Some(&mut raw), &mut size, 0) }.map_err(failed)?;
    raw.truncate(size as usize);
    // CNG gives it little-endian, WebCrypto and CMS read big-endian.
    raw.reverse();
    if raw.len() != field {
        return Err(KeystoreError::Failed("odd secret length".into()));
    }
    Ok(raw)
}

pub fn policy_is_forced(_key: &str) -> bool {
    false
}
