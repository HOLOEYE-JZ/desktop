//! A small DER reader: the X.509 fields the keystore reports, the EC public key
//! `agree` takes, and the ECDSA signature format CMS wants. Nothing here trusts its
//! input: every length is checked, and a certificate this can't read isn't listed.

pub const OID_RSA: &str = "1.2.840.113549.1.1.1";
pub const OID_RSA_PSS: &str = "1.2.840.113549.1.1.10";
pub const OID_EC: &str = "1.2.840.10045.2.1";
const OID_KEY_USAGE: &str = "2.5.29.15";
const OID_EXT_KEY_USAGE: &str = "2.5.29.37";
pub const OID_ANY_EKU: &str = "2.5.29.37.0";
pub const OID_EMAIL_PROTECTION: &str = "1.3.6.1.5.5.7.3.4";

/// Bits of the keyUsage extension, numbered as in RFC 5280, bit 0 the first.
pub const KU_DIGITAL_SIGNATURE: u16 = 1 << 0;
pub const KU_NON_REPUDIATION: u16 = 1 << 1;
pub const KU_KEY_ENCIPHERMENT: u16 = 1 << 2;
pub const KU_DATA_ENCIPHERMENT: u16 = 1 << 3;
pub const KU_KEY_AGREEMENT: u16 = 1 << 4;
pub const KU_KEY_CERT_SIGN: u16 = 1 << 5;
pub const KU_CRL_SIGN: u16 = 1 << 6;

const KEY_USAGE_NAMES: [(u16, &str); 7] = [
    (KU_DIGITAL_SIGNATURE, "digitalSignature"),
    (KU_NON_REPUDIATION, "nonRepudiation"),
    (KU_KEY_ENCIPHERMENT, "keyEncipherment"),
    (KU_DATA_ENCIPHERMENT, "dataEncipherment"),
    (KU_KEY_AGREEMENT, "keyAgreement"),
    (KU_KEY_CERT_SIGN, "keyCertSign"),
    (KU_CRL_SIGN, "cRLSign"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    P256,
    P384,
    P521,
}

impl Curve {
    pub fn name(self) -> &'static str {
        match self {
            Curve::P256 => "P-256",
            Curve::P384 => "P-384",
            Curve::P521 => "P-521",
        }
    }

    /// Bytes of one coordinate, and of the shared secret.
    pub fn field_size(self) -> usize {
        match self {
            Curve::P256 => 32,
            Curve::P384 => 48,
            Curve::P521 => 66,
        }
    }

    pub fn bits(self) -> u32 {
        match self {
            Curve::P256 => 256,
            Curve::P384 => 384,
            Curve::P521 => 521,
        }
    }

    fn from_oid(oid: &str) -> Option<Curve> {
        match oid {
            "1.2.840.10045.3.1.7" => Some(Curve::P256),
            "1.3.132.0.34" => Some(Curve::P384),
            "1.3.132.0.35" => Some(Curve::P521),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    Rsa { bits: u32, pss_only: bool },
    Ec { curve: Curve },
}

#[derive(Debug)]
pub struct Certificate {
    pub subject: String,
    pub issuer: String,
    /// Hex of the serial's bytes as encoded.
    pub serial: String,
    /// Milliseconds since 1970.
    pub not_before: f64,
    pub not_after: f64,
    pub algorithm: String,
    pub key: KeyKind,
    /// None when the certificate has no keyUsage extension: any use.
    pub key_usage: Option<u16>,
    /// None when the certificate has no extendedKeyUsage extension: any use.
    pub extended_key_usage: Option<Vec<String>>,
}

impl Certificate {
    /// keyUsage as names, or nothing without the extension.
    pub fn usage_names(&self) -> Vec<String> {
        let bits = self.key_usage.unwrap_or(0);
        KEY_USAGE_NAMES.iter().filter(|(bit, _)| bits & bit != 0).map(|(_, name)| name.to_string()).collect()
    }

    /// RFC 8550: with an extendedKeyUsage, it has to name mail or any use.
    pub fn allowed_for_mail(&self) -> bool {
        let eku = match &self.extended_key_usage {
            None => true,
            Some(list) => list.iter().any(|oid| oid == OID_EMAIL_PROTECTION || oid == OID_ANY_EKU),
        };
        let wanted = KU_DIGITAL_SIGNATURE | KU_NON_REPUDIATION | KU_KEY_ENCIPHERMENT | KU_KEY_AGREEMENT;
        eku && self.key_usage.is_none_or(|bits| bits & wanted != 0)
    }
}

pub struct Tlv<'a> {
    pub tag: u8,
    pub value: &'a [u8],
}

pub struct Reader<'a> {
    data: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Reader { data }
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn next(&mut self) -> Option<Tlv<'a>> {
        let (&tag, rest) = self.data.split_first()?;
        // Long-form tags don't occur in the structures read here.
        if tag & 0x1f == 0x1f {
            return None;
        }
        let (&first, rest) = rest.split_first()?;
        let (length, rest) = if first < 0x80 {
            (first as usize, rest)
        } else {
            let count = (first & 0x7f) as usize;
            if count == 0 || count > 4 || rest.len() < count {
                return None;
            }
            let (bytes, rest) = rest.split_at(count);
            (bytes.iter().fold(0usize, |sum, byte| (sum << 8) | *byte as usize), rest)
        };
        if rest.len() < length {
            return None;
        }
        let (value, rest) = rest.split_at(length);
        self.data = rest;
        Some(Tlv { tag, value })
    }

    fn expect(&mut self, tag: u8) -> Option<&'a [u8]> {
        let tlv = self.next()?;
        (tlv.tag == tag).then_some(tlv.value)
    }

    /// The next element if it has this tag; otherwise it stays unread.
    fn optional(&mut self, tag: u8) -> Option<&'a [u8]> {
        let mut look = Reader { data: self.data };
        let tlv = look.next()?;
        if tlv.tag != tag {
            return None;
        }
        self.data = look.data;
        Some(tlv.value)
    }
}

const SEQUENCE: u8 = 0x30;
const SET: u8 = 0x31;
const INTEGER: u8 = 0x02;
const BIT_STRING: u8 = 0x03;
const OCTET_STRING: u8 = 0x04;
const OID: u8 = 0x06;

pub fn oid_string(value: &[u8]) -> Option<String> {
    let (&first, rest) = value.split_first()?;
    let mut out = format!("{}.{}", (first / 40).min(2), first - (first / 40).min(2) * 40);
    let mut current: u64 = 0;
    for &byte in rest {
        current = current.checked_mul(128)?.checked_add((byte & 0x7f) as u64)?;
        if byte & 0x80 == 0 {
            out.push('.');
            out.push_str(&current.to_string());
            current = 0;
        }
    }
    (rest.last().is_none_or(|last| last & 0x80 == 0)).then_some(out)
}

fn attribute_name(oid: &str) -> Option<&'static str> {
    Some(match oid {
        "2.5.4.3" => "CN",
        "2.5.4.4" => "SN",
        "2.5.4.5" => "SERIALNUMBER",
        "2.5.4.6" => "C",
        "2.5.4.7" => "L",
        "2.5.4.8" => "ST",
        "2.5.4.9" => "STREET",
        "2.5.4.10" => "O",
        "2.5.4.11" => "OU",
        "2.5.4.12" => "T",
        "2.5.4.42" => "G",
        "1.2.840.113549.1.9.1" => "E",
        "0.9.2342.19200300.100.1.25" => "DC",
        "0.9.2342.19200300.100.1.1" => "UID",
        _ => return None,
    })
}

fn string_value(tag: u8, value: &[u8]) -> Option<String> {
    match tag {
        0x0c | 0x13 | 0x16 => Some(String::from_utf8_lossy(value).into_owned()),
        // T61, in practice Latin-1.
        0x14 => Some(value.iter().map(|byte| *byte as char).collect()),
        0x1e => {
            if value.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = value.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// `CN=Someone, O=Company`, most specific first, as RFC 4514 orders it.
fn name_string(value: &[u8]) -> Option<String> {
    let mut parts = Vec::new();
    let mut rdns = Reader::new(value);
    while !rdns.is_empty() {
        let mut set = Reader::new(rdns.expect(SET)?);
        while !set.is_empty() {
            let mut attribute = Reader::new(set.expect(SEQUENCE)?);
            let oid = oid_string(attribute.expect(OID)?)?;
            let text = attribute.next()?;
            let text = string_value(text.tag, text.value).unwrap_or_default();
            let label = attribute_name(&oid).map(str::to_string).unwrap_or(oid);
            let escaped = text.replace('\\', "\\\\").replace(',', "\\,");
            parts.push(format!("{label}={escaped}"));
        }
    }
    parts.reverse();
    Some(parts.join(", "))
}

/// Days since 1970 from a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted = (month + 9) % 12;
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

fn time_ms(tag: u8, value: &[u8]) -> Option<f64> {
    let text = std::str::from_utf8(value).ok()?.strip_suffix('Z')?;
    if !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let (year, rest) = match (tag, text.len()) {
        (0x17, 12) => {
            let short: i64 = text[..2].parse().ok()?;
            (if short >= 50 { 1900 + short } else { 2000 + short }, &text[2..])
        }
        (0x18, 14) => (text[..4].parse().ok()?, &text[4..]),
        _ => return None,
    };
    let part = |at: usize| -> Option<i64> { rest[at..at + 2].parse().ok() };
    let (month, day, hour, minute, second) = (part(0)?, part(2)?, part(4)?, part(6)?, part(8)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 86400 + hour * 3600 + minute * 60 + second) * 1000) as f64)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn rsa_bits(key: &[u8]) -> Option<u32> {
    let mut outer = Reader::new(key);
    let mut sequence = Reader::new(outer.expect(SEQUENCE)?);
    let modulus = sequence.expect(INTEGER)?;
    let start = modulus.iter().position(|byte| *byte != 0)?;
    let bytes = (modulus.len() - start) as u32;
    Some(bytes * 8 - modulus[start].leading_zeros())
}

fn key_usage_bits(value: &[u8]) -> Option<u16> {
    let mut reader = Reader::new(value);
    let bits = reader.expect(BIT_STRING)?;
    let (_unused, bytes) = bits.split_first()?;
    let mut out = 0u16;
    for (index, byte) in bytes.iter().take(2).enumerate() {
        for bit in 0..8 {
            if byte & (0x80 >> bit) != 0 {
                out |= 1 << (index * 8 + bit);
            }
        }
    }
    Some(out)
}

fn extended_key_usage(value: &[u8]) -> Option<Vec<String>> {
    let mut reader = Reader::new(value);
    let mut list = Reader::new(reader.expect(SEQUENCE)?);
    let mut out = Vec::new();
    while !list.is_empty() {
        out.push(oid_string(list.expect(OID)?)?);
    }
    Some(out)
}

/// Algorithm OID and key of a SubjectPublicKeyInfo's contents.
fn read_spki(value: &[u8]) -> Option<(String, KeyKind)> {
    let mut spki = Reader::new(value);
    let mut algorithm = Reader::new(spki.expect(SEQUENCE)?);
    let oid = oid_string(algorithm.expect(OID)?)?;
    let bits = spki.expect(BIT_STRING)?;
    let (_unused, key) = bits.split_first()?;
    let kind = match oid.as_str() {
        OID_RSA => KeyKind::Rsa { bits: rsa_bits(key)?, pss_only: false },
        OID_RSA_PSS => KeyKind::Rsa { bits: rsa_bits(key)?, pss_only: true },
        OID_EC => {
            let curve = oid_string(algorithm.expect(OID)?)?;
            KeyKind::Ec { curve: Curve::from_oid(&curve)? }
        }
        _ => return None,
    };
    Some((oid, kind))
}

/// None for anything malformed, and for key types the keystore doesn't handle.
pub fn parse_certificate(der: &[u8]) -> Option<Certificate> {
    let mut outer = Reader::new(der);
    let mut certificate = Reader::new(outer.expect(SEQUENCE)?);
    let mut tbs = Reader::new(certificate.expect(SEQUENCE)?);
    let _version = tbs.optional(0xa0);
    let serial = hex(tbs.expect(INTEGER)?);
    tbs.expect(SEQUENCE)?;
    let issuer = name_string(tbs.expect(SEQUENCE)?)?;
    let mut validity = Reader::new(tbs.expect(SEQUENCE)?);
    let from = validity.next()?;
    let to = validity.next()?;
    let subject = name_string(tbs.expect(SEQUENCE)?)?;
    let (algorithm, key) = read_spki(tbs.expect(SEQUENCE)?)?;
    let _issuer_id = tbs.optional(0xa1);
    let _subject_id = tbs.optional(0xa2);

    let mut key_usage = None;
    let mut eku = None;
    if let Some(wrapper) = tbs.optional(0xa3) {
        let mut wrapper = Reader::new(wrapper);
        let mut extensions = Reader::new(wrapper.expect(SEQUENCE)?);
        while !extensions.is_empty() {
            let mut extension = Reader::new(extensions.expect(SEQUENCE)?);
            let oid = oid_string(extension.expect(OID)?)?;
            let _critical = extension.optional(0x01);
            let value = extension.expect(OCTET_STRING)?;
            match oid.as_str() {
                OID_KEY_USAGE => key_usage = Some(key_usage_bits(value)?),
                OID_EXT_KEY_USAGE => eku = Some(extended_key_usage(value)?),
                _ => {}
            }
        }
    }

    Some(Certificate {
        subject,
        issuer,
        serial,
        not_before: time_ms(from.tag, from.value)?,
        not_after: time_ms(to.tag, to.value)?,
        algorithm,
        key,
        key_usage,
        extended_key_usage: eku,
    })
}

/// The curve and X, Y of an EC SubjectPublicKeyInfo with an uncompressed point.
pub fn parse_ec_spki(der: &[u8]) -> Option<(Curve, Vec<u8>, Vec<u8>)> {
    let mut outer = Reader::new(der);
    let spki = outer.expect(SEQUENCE)?;
    if !outer.is_empty() {
        return None;
    }
    let (_, kind) = read_spki(spki)?;
    let KeyKind::Ec { curve } = kind else { return None };
    let mut reader = Reader::new(spki);
    reader.expect(SEQUENCE)?;
    let bits = reader.expect(BIT_STRING)?;
    let (&unused, point) = bits.split_first()?;
    let size = curve.field_size();
    if unused != 0 || point.len() != 1 + 2 * size || point[0] != 0x04 {
        return None;
    }
    Some((curve, point[1..1 + size].to_vec(), point[1 + size..].to_vec()))
}

fn push_length(out: &mut Vec<u8>, length: usize) {
    if length < 0x80 {
        out.push(length as u8);
    } else {
        out.push(0x81);
        out.push(length as u8);
    }
}

fn push_integer(out: &mut Vec<u8>, big_endian: &[u8]) {
    let start = big_endian.iter().position(|byte| *byte != 0).unwrap_or(big_endian.len().saturating_sub(1));
    let bytes = &big_endian[start..];
    let pad = bytes.first().is_some_and(|byte| byte & 0x80 != 0);
    out.push(INTEGER);
    push_length(out, bytes.len() + usize::from(pad));
    if pad {
        out.push(0);
    }
    out.extend_from_slice(bytes);
}

/// CNG's r||s as the DER ECDSA-Sig-Value CMS wants. None for an odd length.
pub fn ecdsa_raw_to_der(raw: &[u8]) -> Option<Vec<u8>> {
    if raw.is_empty() || raw.len() % 2 != 0 || raw.len() > 132 {
        return None;
    }
    let (r, s) = raw.split_at(raw.len() / 2);
    let mut body = Vec::with_capacity(raw.len() + 8);
    push_integer(&mut body, r);
    push_integer(&mut body, s);
    let mut out = Vec::with_capacity(body.len() + 3);
    out.push(SEQUENCE);
    push_length(&mut out, body.len());
    out.extend_from_slice(&body);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reader_refuses_lengths_past_the_end() {
        assert!(Reader::new(&[0x30, 0x05, 0x01]).next().is_none());
        assert!(Reader::new(&[0x30, 0x85, 1, 1, 1, 1, 1]).next().is_none());
        assert!(Reader::new(&[0x30, 0x82, 0x01]).next().is_none());
        assert!(Reader::new(&[]).next().is_none());
    }

    #[test]
    fn garbage_is_no_certificate() {
        assert!(parse_certificate(&[]).is_none());
        assert!(parse_certificate(&[0x30, 0x03, 0x30, 0x01, 0xff]).is_none());
        assert!(parse_certificate(&[0xff; 64]).is_none());
    }

    #[test]
    fn oids_read_as_dotted_numbers() {
        assert_eq!(oid_string(&[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]).as_deref(), Some(OID_EC));
        assert_eq!(oid_string(&[0x55, 0x1d, 0x25, 0x00]).as_deref(), Some(OID_ANY_EKU));
        assert!(oid_string(&[0x2a, 0x86]).is_none(), "a number cut off in the middle");
    }

    #[test]
    fn times_read_in_both_forms() {
        assert_eq!(time_ms(0x17, b"700101000000Z"), Some(0.0));
        assert_eq!(time_ms(0x18, b"19700102000000Z"), Some(86_400_000.0));
        assert_eq!(time_ms(0x17, b"260229120000Z").is_some(), true);
        assert_eq!(time_ms(0x17, b"7001010000Z"), None);
        assert_eq!(time_ms(0x17, b"701301000000Z"), None);
    }

    #[test]
    fn key_usage_bits_count_from_the_first() {
        // digitalSignature and keyEncipherment: 1010 0000, 5 unused bits.
        let value = [0x03, 0x02, 0x05, 0xa0];
        assert_eq!(key_usage_bits(&value), Some(KU_DIGITAL_SIGNATURE | KU_KEY_ENCIPHERMENT));
    }

    #[test]
    fn signatures_become_der_integers() {
        // High bit set gets a zero byte, leading zeros go.
        let mut raw = vec![0u8; 64];
        raw[0] = 0x80;
        raw[63] = 0x01;
        let der = ecdsa_raw_to_der(&raw).unwrap();
        assert_eq!(der[0], 0x30);
        assert_eq!(&der[2..5], &[0x02, 33, 0x00]);
        assert_eq!(&der[der.len() - 3..], &[0x02, 0x01, 0x01]);
        assert_eq!(der[1] as usize, der.len() - 2);
        assert!(ecdsa_raw_to_der(&[1, 2, 3]).is_none());
        assert!(ecdsa_raw_to_der(&[]).is_none());
    }

    #[test]
    fn a_long_signature_uses_a_long_length() {
        // P-521: the body passes 127 bytes.
        let raw = vec![0xffu8; 132];
        let der = ecdsa_raw_to_der(&raw).unwrap();
        assert_eq!(&der[..2], &[0x30, 0x81]);
        assert_eq!(der[2] as usize, der.len() - 3);
    }

    #[test]
    fn mail_use_follows_the_extensions() {
        let certificate = |key_usage, eku: Option<&[&str]>| Certificate {
            subject: String::new(),
            issuer: String::new(),
            serial: String::new(),
            not_before: 0.0,
            not_after: 0.0,
            algorithm: OID_RSA.into(),
            key: KeyKind::Rsa { bits: 2048, pss_only: false },
            key_usage,
            extended_key_usage: eku.map(|list| list.iter().map(|oid| oid.to_string()).collect()),
        };
        assert!(certificate(None, None).allowed_for_mail());
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION])).allowed_for_mail());
        assert!(certificate(None, Some(&[OID_ANY_EKU])).allowed_for_mail());
        assert!(!certificate(None, Some(&["1.3.6.1.5.5.7.3.2"])).allowed_for_mail(), "client authentication only");
        assert!(!certificate(None, Some(&["1.3.6.1.5.5.7.3.3"])).allowed_for_mail(), "code signing only");
        assert!(!certificate(Some(KU_KEY_CERT_SIGN | KU_CRL_SIGN), None).allowed_for_mail(), "a CA");
    }
}
