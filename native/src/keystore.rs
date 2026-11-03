//! What's the same on every OS: checking input, remembering what `list` handed out,
//! and the error codes. The OS modules only find certificates and run the key
//! operation they're given. Nothing here or there can read a private key.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use crate::der::{self, Certificate, Curve, KeyKind};

pub const MAX_LABEL: usize = 256;
pub const MAX_PEER_KEY: usize = 256;
/// What `decrypt` hands back is a CMS content key: AES-256 and ChaCha20 are 32 bytes.
/// A longer result means someone is using the key for something else.
pub const MAX_DECRYPTED: usize = 64;
/// v1.5 unwraps AES-128, 3DES and AES-256 keys. The padding has no integrity, so a wrong
/// guess often decodes to some other length: refusing those keeps it from being an oracle.
const PKCS1_KEY_SIZES: [usize; 3] = [16, 24, 32];

/// Zeroes bytes in a way the compiler can't drop because nothing reads them afterwards.
pub fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: a reference to a live byte is valid for a write.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeystoreError {
    /// The user said no at the OS's prompt.
    Cancelled,
    /// Not from `list`, or gone since.
    NotFound,
    /// This key, provider or OS can't do that.
    Unsupported,
    /// Card out, PIN blocked, locked keychain.
    Locked,
    /// Bad input, whatever the OS would have said.
    Invalid(&'static str),
    Failed(String),
}

impl fmt::Display for KeystoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeystoreError::Cancelled => write!(f, "keystore:cancelled"),
            KeystoreError::NotFound => write!(f, "keystore:not-found"),
            KeystoreError::Unsupported => write!(f, "keystore:unsupported"),
            KeystoreError::Locked => write!(f, "keystore:locked"),
            KeystoreError::Invalid(detail) => write!(f, "keystore:invalid {detail}"),
            KeystoreError::Failed(detail) => write!(f, "keystore:failed {detail}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    fn parse(name: &str) -> Result<Hash, KeystoreError> {
        match name {
            "SHA-1" => Ok(Hash::Sha1),
            "SHA-256" => Ok(Hash::Sha256),
            "SHA-384" => Ok(Hash::Sha384),
            "SHA-512" => Ok(Hash::Sha512),
            _ => Err(KeystoreError::Invalid("unknown hash")),
        }
    }

    pub fn length(self) -> usize {
        match self {
            Hash::Sha1 => 20,
            Hash::Sha256 => 32,
            Hash::Sha384 => 48,
            Hash::Sha512 => 64,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignPlan {
    RsaPkcs1(Hash),
    RsaPss(Hash),
    Ecdsa,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecryptPlan {
    RsaPkcs1,
    RsaOaep { hash: Hash, label: Option<Vec<u8>> },
}

/// What one OS module reports about a certificate with a private key.
pub struct Found {
    pub id: String,
    pub der: Vec<u8>,
    pub chain: Vec<Vec<u8>>,
    pub source: &'static str,
    /// What the key itself allows, if the OS could say without a prompt.
    pub allows: Option<KeyAllows>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyAllows {
    pub sign: bool,
    pub decrypt: bool,
    pub agree: bool,
}

/// One entry of `list`.
pub struct Listed {
    pub found: Found,
    pub certificate: Certificate,
    pub sign_schemes: Vec<String>,
    pub decrypt_schemes: Vec<String>,
    pub can_agree: bool,
    pub ask_each_use: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyFacts {
    pub key: KeyKind,
    pub usage: Option<u16>,
}

impl KeyFacts {
    fn may_sign(&self) -> bool {
        self.usage.is_none_or(|bits| bits & (der::KU_DIGITAL_SIGNATURE | der::KU_NON_REPUDIATION) != 0)
    }

    fn may_decrypt(&self) -> bool {
        matches!(self.key, KeyKind::Rsa { .. }) && self.usage.is_none_or(|bits| bits & der::KU_KEY_ENCIPHERMENT != 0)
    }

    fn may_agree(&self) -> bool {
        matches!(self.key, KeyKind::Ec { .. }) && self.usage.is_none_or(|bits| bits & der::KU_KEY_AGREEMENT != 0)
    }
}

static KNOWN: Mutex<Option<HashMap<String, KeyFacts>>> = Mutex::new(None);

/// Only certificates fit for mail: RFC 8550, and it keeps a sign-in, code signing or
/// CA key in the same store out of reach of the bridge. An id not handed out here is
/// never looked up.
pub fn wanted(der: &[u8]) -> bool {
    der::parse_certificate(der).is_some_and(|certificate| certificate.allowed_for_mail())
}

/// Turns what the OS module found into the list, and makes those the known ids.
pub fn remember(found: Vec<Found>) -> Vec<Listed> {
    let mut known = HashMap::new();
    let mut out = Vec::new();
    for item in found {
        let Some(certificate) = der::parse_certificate(&item.der) else { continue };
        let facts = KeyFacts { key: certificate.key, usage: certificate.key_usage };
        known.insert(item.id.clone(), facts);
        let allows = item.allows.unwrap_or(KeyAllows { sign: true, decrypt: true, agree: true });
        let sign_schemes: Vec<String> = match certificate.key {
            _ if !(facts.may_sign() && allows.sign) => vec![],
            KeyKind::Rsa { pss_only: true, .. } => vec!["rsa-pss".into()],
            KeyKind::Rsa { .. } => vec!["rsa-pkcs1".into(), "rsa-pss".into()],
            KeyKind::Ec { .. } => vec!["ecdsa".into()],
        };
        let decrypt_schemes: Vec<String> = if facts.may_decrypt() && allows.decrypt {
            vec!["rsa-pkcs1".into(), "rsa-oaep".into()]
        } else {
            vec![]
        };
        let can_agree = facts.may_agree() && allows.agree;
        let ask_each_use = certificate.ask_each_use();
        out.push(Listed { found: item, certificate, sign_schemes, decrypt_schemes, can_agree, ask_each_use });
    }
    *KNOWN.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(known);
    out
}

/// The facts of an id `list` handed out.
pub fn known(id: &str) -> Result<KeyFacts, KeystoreError> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(KeystoreError::Invalid("id"));
    }
    let guard = KNOWN.lock().unwrap_or_else(|poison| poison.into_inner());
    guard.as_ref().and_then(|map| map.get(id)).copied().ok_or(KeystoreError::NotFound)
}

pub fn check_sign(facts: &KeyFacts, digest: &[u8], scheme: &str, hash: &str) -> Result<SignPlan, KeystoreError> {
    let hash = Hash::parse(hash)?;
    // SHA-1 signatures are forgeable. Nothing needs them: decrypt keeps it for OAEP.
    if hash == Hash::Sha1 {
        return Err(KeystoreError::Unsupported);
    }
    if digest.len() != hash.length() {
        return Err(KeystoreError::Invalid("digest length"));
    }
    if !facts.may_sign() {
        return Err(KeystoreError::Unsupported);
    }
    match (scheme, facts.key) {
        ("rsa-pkcs1", KeyKind::Rsa { pss_only: false, .. }) => Ok(SignPlan::RsaPkcs1(hash)),
        ("rsa-pss", KeyKind::Rsa { .. }) => Ok(SignPlan::RsaPss(hash)),
        ("ecdsa", KeyKind::Ec { .. }) => Ok(SignPlan::Ecdsa),
        ("rsa-pkcs1" | "rsa-pss" | "ecdsa", _) => Err(KeystoreError::Unsupported),
        _ => Err(KeystoreError::Invalid("scheme")),
    }
}

pub fn check_decrypt(
    facts: &KeyFacts,
    data: &[u8],
    scheme: &str,
    hash: Option<&str>,
    label: Option<&[u8]>,
) -> Result<DecryptPlan, KeystoreError> {
    let plan = match scheme {
        "rsa-pkcs1" => {
            if hash.is_some() || label.is_some() {
                return Err(KeystoreError::Invalid("scheme"));
            }
            DecryptPlan::RsaPkcs1
        }
        "rsa-oaep" => {
            let hash = Hash::parse(hash.ok_or(KeystoreError::Invalid("hash"))?)?;
            if label.is_some_and(|label| label.len() > MAX_LABEL) {
                return Err(KeystoreError::Invalid("label"));
            }
            DecryptPlan::RsaOaep { hash, label: label.filter(|label| !label.is_empty()).map(<[u8]>::to_vec) }
        }
        _ => return Err(KeystoreError::Invalid("scheme")),
    };
    let KeyKind::Rsa { bits, .. } = facts.key else { return Err(KeystoreError::Unsupported) };
    if !facts.may_decrypt() {
        return Err(KeystoreError::Unsupported);
    }
    if data.len() != (bits as usize).div_ceil(8) {
        return Err(KeystoreError::Invalid("data length"));
    }
    Ok(plan)
}

/// What a decryption's outcome may say. A bad padding and an answer of the wrong size
/// read exactly the same, so a caller can't tell them apart and use the key as an oracle.
/// Not the OS's error code either. An answer that's refused is wiped here.
pub fn check_decrypted(answer: Result<Vec<u8>, KeystoreError>, plan: &DecryptPlan) -> Result<Vec<u8>, KeystoreError> {
    let refused = || KeystoreError::Failed("decrypt".into());
    let mut plain = match answer {
        Ok(plain) => plain,
        Err(KeystoreError::Failed(_)) => return Err(refused()),
        Err(other) => return Err(other),
    };
    let fits = match plan {
        DecryptPlan::RsaPkcs1 => PKCS1_KEY_SIZES.contains(&plain.len()),
        DecryptPlan::RsaOaep { .. } => plain.len() <= MAX_DECRYPTED,
    };
    if !fits {
        wipe(&mut plain);
        return Err(refused());
    }
    Ok(plain)
}

pub struct PeerKey {
    pub curve: Curve,
    pub x: Vec<u8>,
    pub y: Vec<u8>,
}

pub fn check_agree(facts: &KeyFacts, peer: &[u8]) -> Result<PeerKey, KeystoreError> {
    if peer.len() > MAX_PEER_KEY {
        return Err(KeystoreError::Invalid("peer key"));
    }
    let KeyKind::Ec { curve } = facts.key else { return Err(KeystoreError::Unsupported) };
    if !facts.may_agree() {
        return Err(KeystoreError::Unsupported);
    }
    let (peer_curve, x, y) = der::parse_ec_spki(peer).ok_or(KeystoreError::Invalid("peer key"))?;
    if peer_curve != curve {
        return Err(KeystoreError::Invalid("peer key curve"));
    }
    Ok(PeerKey { curve, x, y })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSA: KeyFacts = KeyFacts { key: KeyKind::Rsa { bits: 2048, pss_only: false }, usage: None };
    const EC: KeyFacts = KeyFacts { key: KeyKind::Ec { curve: Curve::P256 }, usage: None };

    fn digest(length: usize) -> Vec<u8> {
        vec![7; length]
    }

    #[test]
    fn a_digest_must_be_as_long_as_its_hash() {
        assert_eq!(check_sign(&RSA, &digest(32), "rsa-pkcs1", "SHA-256"), Ok(SignPlan::RsaPkcs1(Hash::Sha256)));
        assert_eq!(check_sign(&RSA, &digest(48), "rsa-pss", "SHA-384"), Ok(SignPlan::RsaPss(Hash::Sha384)));
        assert_eq!(check_sign(&EC, &digest(64), "ecdsa", "SHA-512"), Ok(SignPlan::Ecdsa));
        assert_eq!(check_sign(&RSA, &digest(31), "rsa-pkcs1", "SHA-256"), Err(KeystoreError::Invalid("digest length")));
        assert_eq!(check_sign(&RSA, &digest(48), "rsa-pkcs1", "SHA-256"), Err(KeystoreError::Invalid("digest length")));
        assert_eq!(check_sign(&RSA, &digest(0), "rsa-pkcs1", "SHA-256"), Err(KeystoreError::Invalid("digest length")));
    }

    #[test]
    fn nothing_signs_sha1() {
        assert_eq!(check_sign(&RSA, &digest(20), "rsa-pkcs1", "SHA-1"), Err(KeystoreError::Unsupported));
        assert_eq!(check_sign(&EC, &digest(20), "ecdsa", "SHA-1"), Err(KeystoreError::Unsupported));
    }

    #[test]
    fn a_scheme_must_fit_the_key() {
        assert_eq!(check_sign(&RSA, &digest(32), "ecdsa", "SHA-256"), Err(KeystoreError::Unsupported));
        assert_eq!(check_sign(&EC, &digest(32), "rsa-pss", "SHA-256"), Err(KeystoreError::Unsupported));
        assert_eq!(check_sign(&RSA, &digest(32), "made-up", "SHA-256"), Err(KeystoreError::Invalid("scheme")));
        assert_eq!(check_sign(&RSA, &digest(32), "rsa-pkcs1", "MD5"), Err(KeystoreError::Invalid("unknown hash")));
        let pss = KeyFacts { key: KeyKind::Rsa { bits: 2048, pss_only: true }, usage: None };
        assert_eq!(check_sign(&pss, &digest(32), "rsa-pkcs1", "SHA-256"), Err(KeystoreError::Unsupported));
        assert_eq!(check_sign(&pss, &digest(32), "rsa-pss", "SHA-256"), Ok(SignPlan::RsaPss(Hash::Sha256)));
    }

    #[test]
    fn key_usage_decides_what_a_key_may_do() {
        let encrypt_only = KeyFacts { usage: Some(der::KU_KEY_ENCIPHERMENT), ..RSA };
        assert_eq!(check_sign(&encrypt_only, &digest(32), "rsa-pkcs1", "SHA-256"), Err(KeystoreError::Unsupported));
        assert!(check_decrypt(&encrypt_only, &digest(256), "rsa-pkcs1", None, None).is_ok());
        let sign_only = KeyFacts { usage: Some(der::KU_DIGITAL_SIGNATURE), ..RSA };
        assert!(check_sign(&sign_only, &digest(32), "rsa-pkcs1", "SHA-256").is_ok());
        assert_eq!(check_decrypt(&sign_only, &digest(256), "rsa-pkcs1", None, None), Err(KeystoreError::Unsupported));
        let non_repudiation = KeyFacts { usage: Some(der::KU_NON_REPUDIATION), ..RSA };
        assert!(check_sign(&non_repudiation, &digest(32), "rsa-pkcs1", "SHA-256").is_ok());
    }

    #[test]
    fn ciphertext_must_be_as_long_as_the_modulus() {
        assert!(check_decrypt(&RSA, &digest(256), "rsa-oaep", Some("SHA-1"), None).is_ok());
        assert_eq!(check_decrypt(&RSA, &digest(255), "rsa-pkcs1", None, None), Err(KeystoreError::Invalid("data length")));
        assert_eq!(check_decrypt(&RSA, &digest(257), "rsa-pkcs1", None, None), Err(KeystoreError::Invalid("data length")));
        assert_eq!(check_decrypt(&RSA, &digest(1 << 20), "rsa-pkcs1", None, None), Err(KeystoreError::Invalid("data length")));
    }

    #[test]
    fn oaep_needs_a_hash_and_a_small_label() {
        assert_eq!(check_decrypt(&RSA, &digest(256), "rsa-oaep", None, None), Err(KeystoreError::Invalid("hash")));
        let long = vec![0; MAX_LABEL + 1];
        assert_eq!(check_decrypt(&RSA, &digest(256), "rsa-oaep", Some("SHA-256"), Some(&long)), Err(KeystoreError::Invalid("label")));
        assert_eq!(
            check_decrypt(&RSA, &digest(256), "rsa-oaep", Some("SHA-256"), Some(&[])),
            Ok(DecryptPlan::RsaOaep { hash: Hash::Sha256, label: None }),
            "an empty label is no label"
        );
        assert_eq!(check_decrypt(&RSA, &digest(256), "rsa-pkcs1", Some("SHA-256"), None), Err(KeystoreError::Invalid("scheme")));
    }

    #[test]
    fn an_ec_key_doesnt_decrypt_and_an_rsa_key_doesnt_agree() {
        assert_eq!(check_decrypt(&EC, &digest(32), "rsa-pkcs1", None, None), Err(KeystoreError::Unsupported));
        assert!(matches!(check_agree(&RSA, &digest(91)), Err(KeystoreError::Unsupported)));
    }

    #[test]
    fn wipe_zeroes_the_bytes() {
        let mut bytes = vec![0xaa; 32];
        wipe(&mut bytes);
        assert_eq!(bytes, vec![0; 32]);
        let mut part = [1u8, 2, 3, 4];
        wipe(&mut part[1..3]);
        assert_eq!(part, [1, 0, 0, 4]);
    }

    fn oaep() -> DecryptPlan {
        DecryptPlan::RsaOaep { hash: Hash::Sha256, label: None }
    }

    #[test]
    fn v1_5_answers_only_with_a_content_key_size() {
        for size in [16, 24, 32] {
            assert_eq!(check_decrypted(Ok(vec![1; size]), &DecryptPlan::RsaPkcs1), Ok(vec![1; size]));
        }
        for size in [0, 1, 15, 17, 23, 25, 31, 33, 64, 65] {
            assert_eq!(check_decrypted(Ok(vec![1; size]), &DecryptPlan::RsaPkcs1), Err(KeystoreError::Failed("decrypt".into())), "{size}");
        }
    }

    #[test]
    fn oaep_answers_up_to_the_limit() {
        assert_eq!(check_decrypted(Ok(vec![1; 20]), &oaep()), Ok(vec![1; 20]));
        assert_eq!(check_decrypted(Ok(vec![1; MAX_DECRYPTED]), &oaep()), Ok(vec![1; MAX_DECRYPTED]));
        assert_eq!(check_decrypted(Ok(vec![1; MAX_DECRYPTED + 1]), &oaep()), Err(KeystoreError::Failed("decrypt".into())));
    }

    #[test]
    fn every_decrypt_failure_reads_the_same_but_a_person_saying_no_stays_itself() {
        let bad_padding = check_decrypted(Err(KeystoreError::Failed("0x80090027".into())), &DecryptPlan::RsaPkcs1);
        let wrong_size = check_decrypted(Ok(vec![1; 20]), &DecryptPlan::RsaPkcs1);
        assert_eq!(bad_padding, wrong_size);
        assert_eq!(bad_padding.unwrap_err().to_string(), "keystore:failed decrypt");
        assert_eq!(check_decrypted(Err(KeystoreError::Cancelled), &oaep()), Err(KeystoreError::Cancelled));
        assert_eq!(check_decrypted(Err(KeystoreError::Locked), &oaep()), Err(KeystoreError::Locked));
        assert_eq!(check_decrypted(Err(KeystoreError::Unsupported), &oaep()), Err(KeystoreError::Unsupported));
    }

    #[test]
    fn an_id_is_lowercase_hex_and_from_the_list() {
        assert_eq!(known("nope"), Err(KeystoreError::Invalid("id")));
        assert_eq!(known(&"A".repeat(64)), Err(KeystoreError::Invalid("id")));
        assert_eq!(known(&"a".repeat(64)), Err(KeystoreError::NotFound));
    }
}
