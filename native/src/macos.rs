//! macOS: keychain and token identities through Security.framework, and whether a
//! preference is forced by a configuration profile. Hello isn't here: Electron's
//! systemPreferences.promptTouchID does that without a helper.
//!
//! Type-checked with `cargo check --target aarch64-apple-darwin`. Not run yet.

use std::time::Duration;

use core_foundation::base::{CFType, TCFType};
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::error::CFError;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::preferences::{kCFPreferencesCurrentApplication, CFPreferencesAppValueIsForced};
use security_framework::identity::SecIdentity;
use security_framework::item::{ItemClass, ItemSearchOptions, Limit, Reference, SearchResult};
use security_framework::key::{Algorithm, SecKey};
use security_framework::os::macos::certificate::SecCertificateExt;
use security_framework::policy::SecPolicy;
use security_framework::trust::SecTrust;
use security_framework_sys::item::{kSecAttrKeyClass, kSecAttrKeyClassPublic, kSecAttrKeySizeInBits, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom};
use security_framework_sys::key::SecKeyCreateWithData;

use crate::keystore::{DecryptPlan, Found, Hash, KeystoreError, PeerKey, SignPlan};

const ERR_USER_CANCELED: i64 = -128;
const ERR_AUTH_FAILED: i64 = -25293;
const ERR_INTERACTION_NOT_ALLOWED: i64 = -25308;
const ERR_ITEM_NOT_FOUND: i64 = -25300;
const ERR_UNIMPLEMENTED: i64 = -4;
const ERR_PARAM: i64 = -50;
/// LAError and TKError's "user cancelled" arrive with these codes on token keys.
const LA_USER_CANCEL: i64 = -2;
const TK_CANCELED_BY_USER: i64 = -9;

fn map_error(error: &CFError) -> KeystoreError {
    let code = error.code() as i64;
    match code {
        ERR_USER_CANCELED | LA_USER_CANCEL | TK_CANCELED_BY_USER => KeystoreError::Cancelled,
        ERR_AUTH_FAILED | ERR_INTERACTION_NOT_ALLOWED => KeystoreError::Locked,
        ERR_ITEM_NOT_FOUND => KeystoreError::NotFound,
        ERR_UNIMPLEMENTED | ERR_PARAM => KeystoreError::Unsupported,
        _ => KeystoreError::Failed(format!("{code}")),
    }
}

pub fn hello_available() -> bool {
    false
}

pub fn hello_verify(_reason: &str, _hwnd: &[u8], _timeout: Duration) -> &'static str {
    "unavailable"
}

/// Identities in one search: the keychains, or the tokens (smart cards). No matches
/// come back as an error, so a failed search is an empty one.
fn identities(tokens: bool) -> Vec<SecIdentity> {
    let mut options = ItemSearchOptions::new();
    options.class(ItemClass::identity()).load_refs(true).limit(Limit::All);
    if tokens {
        options.access_group_token();
    }
    let results = options.search().unwrap_or_default();
    results
        .into_iter()
        .filter_map(|result| match result {
            SearchResult::Ref(Reference::Identity(identity)) => Some(identity),
            _ => None,
        })
        .collect()
}

fn id_of(certificate: &security_framework::certificate::SecCertificate) -> Option<String> {
    let hash = certificate.fingerprint().ok()?;
    Some(hash.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Intermediates only, leaf and root left out, with no network fetch.
fn chain_of(certificate: &security_framework::certificate::SecCertificate) -> Vec<Vec<u8>> {
    let Ok(mut trust) = SecTrust::create_with_certificates(std::slice::from_ref(certificate), &[SecPolicy::create_x509()]) else {
        return vec![];
    };
    let _ = trust.set_network_fetch_allowed(false);
    // An untrusted chain is still a chain: only its certificates are wanted.
    let _ = trust.evaluate_with_error();
    let mut chain = trust.chain();
    if chain.is_empty() {
        return vec![];
    }
    chain.remove(0);
    if let Some(last) = chain.last() {
        if last.subject() == last.issuer() {
            chain.pop();
        }
    }
    chain.iter().map(|certificate| certificate.to_der()).collect()
}

pub fn enumerate(wanted: impl Fn(&[u8]) -> bool) -> Result<Vec<Found>, KeystoreError> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (tokens, source) in [(false, "keychain"), (true, "smartcard")] {
        for identity in identities(tokens) {
            let Ok(certificate) = identity.certificate() else { continue };
            let der = certificate.to_der();
            if !wanted(&der) {
                continue;
            }
            let Some(id) = id_of(&certificate) else { continue };
            if seen.insert(id.clone()) {
                out.push(Found { id, chain: chain_of(&certificate), der, source, allows: None });
            }
        }
    }
    Ok(out)
}

fn private_key(id: &str) -> Result<SecKey, KeystoreError> {
    for tokens in [false, true] {
        for identity in identities(tokens) {
            let Ok(certificate) = identity.certificate() else { continue };
            if id_of(&certificate).as_deref() == Some(id) {
                return identity.private_key().map_err(|error| KeystoreError::Failed(format!("{}", error.code())));
            }
        }
    }
    Err(KeystoreError::NotFound)
}

fn signature_algorithm(plan: SignPlan, digest_length: usize) -> Result<Algorithm, KeystoreError> {
    Ok(match plan {
        SignPlan::RsaPkcs1(Hash::Sha256) => Algorithm::RSASignatureDigestPKCS1v15SHA256,
        SignPlan::RsaPkcs1(Hash::Sha384) => Algorithm::RSASignatureDigestPKCS1v15SHA384,
        SignPlan::RsaPkcs1(Hash::Sha512) => Algorithm::RSASignatureDigestPKCS1v15SHA512,
        // Digest PSS on macOS uses salt = hash length, as asked.
        SignPlan::RsaPss(Hash::Sha256) => Algorithm::RSASignatureDigestPSSSHA256,
        SignPlan::RsaPss(Hash::Sha384) => Algorithm::RSASignatureDigestPSSSHA384,
        SignPlan::RsaPss(Hash::Sha512) => Algorithm::RSASignatureDigestPSSSHA512,
        SignPlan::Ecdsa => match digest_length {
            32 => Algorithm::ECDSASignatureDigestX962SHA256,
            48 => Algorithm::ECDSASignatureDigestX962SHA384,
            64 => Algorithm::ECDSASignatureDigestX962SHA512,
            _ => return Err(KeystoreError::Unsupported),
        },
        SignPlan::RsaPkcs1(Hash::Sha1) | SignPlan::RsaPss(Hash::Sha1) => return Err(KeystoreError::Unsupported),
    })
}

/// macOS already gives ECDSA as X9.62 DER, the format CMS wants.
pub fn sign(id: &str, digest: &[u8], plan: SignPlan, _hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    let algorithm = signature_algorithm(plan, digest.len())?;
    private_key(id)?.create_signature(algorithm, digest).map_err(|error| map_error(&error))
}

pub fn decrypt(id: &str, data: &[u8], plan: &DecryptPlan, _hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    let algorithm = match plan {
        DecryptPlan::RsaPkcs1 => Algorithm::RSAEncryptionPKCS1,
        // SecKey has no argument for an OAEP label.
        DecryptPlan::RsaOaep { label: Some(_), .. } => return Err(KeystoreError::Unsupported),
        DecryptPlan::RsaOaep { hash: Hash::Sha1, .. } => Algorithm::RSAEncryptionOAEPSHA1,
        DecryptPlan::RsaOaep { hash: Hash::Sha256, .. } => Algorithm::RSAEncryptionOAEPSHA256,
        DecryptPlan::RsaOaep { hash: Hash::Sha384, .. } => Algorithm::RSAEncryptionOAEPSHA384,
        DecryptPlan::RsaOaep { hash: Hash::Sha512, .. } => Algorithm::RSAEncryptionOAEPSHA512,
    };
    private_key(id)?.decrypt_data(algorithm, data).map_err(|error| map_error(&error))
}

fn public_key_from(peer: &PeerKey) -> Result<SecKey, KeystoreError> {
    let mut point = Vec::with_capacity(1 + peer.x.len() + peer.y.len());
    point.push(0x04);
    point.extend_from_slice(&peer.x);
    point.extend_from_slice(&peer.y);
    let data = CFData::from_buffer(&point);
    let attributes: CFDictionary<CFString, CFType> = unsafe {
        CFDictionary::from_CFType_pairs(&[
            (CFString::wrap_under_get_rule(kSecAttrKeyType), CFString::wrap_under_get_rule(kSecAttrKeyTypeECSECPrimeRandom).into_CFType()),
            (CFString::wrap_under_get_rule(kSecAttrKeyClass), CFString::wrap_under_get_rule(kSecAttrKeyClassPublic).into_CFType()),
            (CFString::wrap_under_get_rule(kSecAttrKeySizeInBits), CFNumber::from(peer.curve.bits() as i64).into_CFType()),
        ])
    };
    let mut error = std::ptr::null_mut();
    let key = unsafe { SecKeyCreateWithData(data.as_concrete_TypeRef(), attributes.as_concrete_TypeRef(), &mut error) };
    if key.is_null() {
        if !error.is_null() {
            drop(unsafe { CFError::wrap_under_create_rule(error) });
        }
        return Err(KeystoreError::Invalid("peer key"));
    }
    Ok(unsafe { SecKey::wrap_under_create_rule(key) })
}

pub fn agree(id: &str, peer: &PeerKey, _hwnd: Option<&[u8]>) -> Result<Vec<u8>, KeystoreError> {
    let public_key = public_key_from(peer)?;
    let secret = private_key(id)?
        .key_exchange(Algorithm::ECDHKeyExchangeStandard, &public_key, peer.curve.field_size(), None)
        .map_err(|error| map_error(&error))?;
    if secret.len() != peer.curve.field_size() {
        return Err(KeystoreError::Failed("odd secret length".into()));
    }
    Ok(secret)
}

/// NSUserDefaults' objectIsForcedForKey, by its CoreFoundation name.
pub fn policy_is_forced(key: &str) -> bool {
    let key = CFString::new(key);
    unsafe { CFPreferencesAppValueIsForced(key.as_concrete_TypeRef(), kCFPreferencesCurrentApplication) != 0 }
}
