//! A small DER reader: the X.509 fields the keystore reports, the EC public key
//! `agree` takes, and the ECDSA signature format CMS wants. Nothing here trusts its
//! input: every length is checked, and a certificate this can't read isn't listed.

pub const OID_RSA: &str = "1.2.840.113549.1.1.1";
pub const OID_RSA_PSS: &str = "1.2.840.113549.1.1.10";
pub const OID_EC: &str = "1.2.840.10045.2.1";
const OID_KEY_USAGE: &str = "2.5.29.15";
const OID_EXT_KEY_USAGE: &str = "2.5.29.37";
const OID_BASIC_CONSTRAINTS: &str = "2.5.29.19";
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
    /// basicConstraints says cA=true.
    pub is_ca: bool,
}

impl Certificate {
    /// keyUsage as names, or nothing without the extension.
    pub fn usage_names(&self) -> Vec<String> {
        let bits = self.key_usage.unwrap_or(0);
        KEY_USAGE_NAMES.iter().filter(|(bit, _)| bits & bit != 0).map(|(_, name)| name.to_string()).collect()
    }

    /// RFC 8550: with an extendedKeyUsage, it has to name mail or any use. A CA is never
    /// fit, however its key usage reads: signing with it could issue certificates.
    pub fn allowed_for_mail(&self) -> bool {
        if self.is_ca || self.key_usage.is_some_and(|bits| bits & (KU_KEY_CERT_SIGN | KU_CRL_SIGN) != 0) {
            return false;
        }
        let eku = match &self.extended_key_usage {
            None => true,
            Some(list) => list.iter().any(|oid| oid == OID_EMAIL_PROTECTION || oid == OID_ANY_EKU),
        };
        let wanted = KU_DIGITAL_SIGNATURE | KU_NON_REPUDIATION | KU_KEY_ENCIPHERMENT | KU_KEY_AGREEMENT;
        eku && self.key_usage.is_none_or(|bits| bits & wanted != 0)
    }

    /// Consent per operation, not for a while, unless this key does mail and nothing else:
    /// its extended key usage is exactly email protection. Anything broader could also sign
    /// code or sign the user in. A key with nonRepudiation is a qualified signing key, whose
    /// signature can bind the user legally, so it asks whatever else it says.
    pub fn ask_each_use(&self) -> bool {
        if self.key_usage.is_some_and(|bits| bits & KU_NON_REPUDIATION != 0) {
            return true;
        }
        match &self.extended_key_usage {
            Some(list) => !matches!(list.as_slice(), [only] if only == OID_EMAIL_PROTECTION),
            None => true,
        }
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

/// A name as a person reads it. Certificates are written by whoever made them, and the
/// consent dialog shows this: no control characters to fake a line, and none of the
/// invisible or direction-changing ones that make one name look like another.
fn clean_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}')
        })
        .collect()
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
            let text = clean_text(&string_value(text.tag, text.value).unwrap_or_default());
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

fn basic_constraints_ca(value: &[u8]) -> Option<bool> {
    let mut reader = Reader::new(value);
    let mut sequence = Reader::new(reader.expect(SEQUENCE)?);
    // cA defaults to false. In DER it's only there when true.
    Some(sequence.optional(0x01).is_some_and(|flag| flag.first().is_some_and(|byte| *byte != 0)))
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
    let mut is_ca = false;
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
                OID_BASIC_CONSTRAINTS => is_ca = basic_constraints_ca(value)?,
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
        is_ca,
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
    let (x, y) = (&point[1..1 + size], &point[1 + size..]);
    on_curve(curve, x, y).then(|| (curve, x.to_vec(), y.to_vec()))
}

/// Little-endian 64-bit limbs, wide enough for P-521 with room to add.
type Wide = [u64; 9];

fn wide_from_hex(hex: &str) -> Wide {
    let bytes: Vec<u8> = (0..hex.len() / 2).map(|at| u8::from_str_radix(&hex[at * 2..at * 2 + 2], 16).unwrap_or(0)).collect();
    wide_from_bytes(&bytes)
}

fn wide_from_bytes(big_endian: &[u8]) -> Wide {
    let mut out = [0u64; 9];
    for (index, byte) in big_endian.iter().rev().enumerate().take(9 * 8) {
        out[index / 8] |= (*byte as u64) << (index % 8 * 8);
    }
    out
}

fn wide_less(a: &Wide, b: &Wide) -> bool {
    a.iter().rev().lt(b.iter().rev())
}

fn wide_add_mod(a: &Wide, b: &Wide, p: &Wide) -> Wide {
    let mut sum = [0u64; 9];
    let mut carry = false;
    for index in 0..9 {
        let (partial, first) = a[index].overflowing_add(b[index]);
        let (total, second) = partial.overflowing_add(carry as u64);
        sum[index] = total;
        carry = first || second;
    }
    if wide_less(&sum, p) {
        return sum;
    }
    let mut out = [0u64; 9];
    let mut borrow = false;
    for index in 0..9 {
        let (partial, first) = sum[index].overflowing_sub(p[index]);
        let (total, second) = partial.overflowing_sub(borrow as u64);
        out[index] = total;
        borrow = first || second;
    }
    out
}

/// Double and add. Slow by bignum standards, and public values only, so no need for more.
fn wide_mul_mod(a: &Wide, b: &Wide, p: &Wide) -> Wide {
    let mut out = [0u64; 9];
    for limb in b.iter().rev() {
        for bit in (0..64).rev() {
            out = wide_add_mod(&out, &out, p);
            if limb >> bit & 1 == 1 {
                out = wide_add_mod(&out, a, p);
            }
        }
    }
    out
}

/// y^2 = x^3 - 3x + b, with both below p. On the three NIST curves a = p - 3. The OS's
/// provider would normally say this too, but a third-party provider or macOS might not,
/// and an off-curve point is how an invalid-curve attack reads a private key.
fn on_curve(curve: Curve, x: &[u8], y: &[u8]) -> bool {
    let (p, b) = match curve {
        Curve::P256 => (
            "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
            "5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
        ),
        Curve::P384 => (
            "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff",
            "b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef",
        ),
        Curve::P521 => (
            "01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00",
        ),
    };
    let (p, b) = (wide_from_hex(p), wide_from_hex(b));
    let (x, y) = (wide_from_bytes(x), wide_from_bytes(y));
    if !wide_less(&x, &p) || !wide_less(&y, &p) {
        return false;
    }
    let three_x = wide_add_mod(&wide_add_mod(&x, &x, &p), &x, &p);
    let cube = wide_mul_mod(&wide_mul_mod(&x, &x, &p), &x, &p);
    // Both sides moved so nothing has to subtract: y^2 + 3x = x^3 + b.
    let left = wide_add_mod(&wide_mul_mod(&y, &y, &p), &three_x, &p);
    let right = wide_add_mod(&cube, &b, &p);
    left == right
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

    const OID_CLIENT_AUTH: &str = "1.3.6.1.5.5.7.3.2";
    const OID_SMARTCARD_LOGON: &str = "1.3.6.1.4.1.311.20.2.2";
    const OID_CODE_SIGNING: &str = "1.3.6.1.5.5.7.3.3";

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

    fn certificate(key_usage: Option<u16>, eku: Option<&[&str]>, is_ca: bool) -> Certificate {
        Certificate {
            subject: String::new(),
            issuer: String::new(),
            serial: String::new(),
            not_before: 0.0,
            not_after: 0.0,
            algorithm: OID_RSA.into(),
            key: KeyKind::Rsa { bits: 2048, pss_only: false },
            key_usage,
            extended_key_usage: eku.map(|list| list.iter().map(|oid| oid.to_string()).collect()),
            is_ca,
        }
    }

    #[test]
    fn mail_use_follows_the_extensions() {
        assert!(certificate(None, None, false).allowed_for_mail());
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION]), false).allowed_for_mail());
        assert!(certificate(None, Some(&[OID_ANY_EKU]), false).allowed_for_mail());
        assert!(!certificate(None, Some(&[OID_CLIENT_AUTH]), false).allowed_for_mail(), "client authentication only");
        assert!(!certificate(None, Some(&["1.3.6.1.5.5.7.3.3"]), false).allowed_for_mail(), "code signing only");
    }

    #[test]
    fn a_ca_is_never_fit_for_mail() {
        assert!(!certificate(Some(KU_KEY_CERT_SIGN | KU_CRL_SIGN), None, false).allowed_for_mail());
        assert!(!certificate(Some(KU_DIGITAL_SIGNATURE | KU_KEY_CERT_SIGN), None, false).allowed_for_mail(), "keyCertSign beside digitalSignature");
        assert!(!certificate(Some(KU_DIGITAL_SIGNATURE | KU_CRL_SIGN), None, false).allowed_for_mail(), "cRLSign beside digitalSignature");
        assert!(!certificate(Some(KU_DIGITAL_SIGNATURE), Some(&[OID_EMAIL_PROTECTION]), true).allowed_for_mail(), "cA=true");
        assert!(!certificate(None, None, true).allowed_for_mail(), "cA=true and nothing else");
    }

    #[test]
    fn basic_constraints_read_the_flag() {
        // SEQUENCE { BOOLEAN TRUE }, an empty SEQUENCE, and garbage.
        assert_eq!(basic_constraints_ca(&[0x30, 0x03, 0x01, 0x01, 0xff]), Some(true));
        assert_eq!(basic_constraints_ca(&[0x30, 0x00]), Some(false));
        assert_eq!(basic_constraints_ca(&[0x01]), None);
    }

    #[test]
    fn a_key_that_can_sign_in_asks_each_time() {
        assert!(!certificate(None, Some(&[OID_EMAIL_PROTECTION]), false).ask_each_use());
        assert!(certificate(None, None, false).ask_each_use(), "no extended key usage: any use");
        assert!(certificate(None, Some(&[OID_ANY_EKU]), false).ask_each_use());
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION, OID_CLIENT_AUTH]), false).ask_each_use());
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION, OID_SMARTCARD_LOGON]), false).ask_each_use());
    }

    #[test]
    fn only_a_key_for_mail_alone_gets_a_grant() {
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION, OID_CODE_SIGNING]), false).ask_each_use(), "code signing too");
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION, "1.2.3.4"]), false).ask_each_use(), "something nobody here knows");
        assert!(certificate(None, Some(&[OID_EMAIL_PROTECTION, OID_EMAIL_PROTECTION]), false).ask_each_use(), "not exactly the one");
        assert!(certificate(None, Some(&[]), false).ask_each_use(), "an empty list");
        assert!(!certificate(Some(KU_DIGITAL_SIGNATURE | KU_KEY_ENCIPHERMENT), Some(&[OID_EMAIL_PROTECTION]), false).ask_each_use());
    }

    #[test]
    fn a_qualified_signing_key_asks_each_time() {
        assert!(certificate(Some(KU_NON_REPUDIATION), Some(&[OID_EMAIL_PROTECTION]), false).ask_each_use());
        assert!(certificate(Some(KU_DIGITAL_SIGNATURE | KU_NON_REPUDIATION), Some(&[OID_EMAIL_PROTECTION]), false).ask_each_use());
    }

    #[test]
    fn names_lose_what_a_reader_cannot_see() {
        assert_eq!(clean_text("Some\nOne\r\t\u{7f}\u{85}"), "SomeOne");
        assert_eq!(clean_text("a\u{202e}b\u{200b}c\u{2066}d\u{feff}e\u{ad}f"), "abcdef");
        assert_eq!(clean_text("J\u{fc}rgen \u{674e}"), "J\u{fc}rgen \u{674e}");
    }

    #[test]
    fn a_subject_with_a_line_break_reads_as_one_line() {
        // SEQUENCE { SET { SEQUENCE { CN, UTF8String "a\nIssuer: b" } } }
        let text = b"a\nIssuer: b";
        let mut attribute = vec![0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, text.len() as u8];
        attribute.extend_from_slice(text);
        let mut sequence = vec![0x30, attribute.len() as u8];
        sequence.extend_from_slice(&attribute);
        let mut set = vec![0x31, sequence.len() as u8];
        set.extend_from_slice(&sequence);
        assert_eq!(name_string(&set).as_deref(), Some("CN=aIssuer: b"));
    }

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len() / 2).map(|at| u8::from_str_radix(&hex[at * 2..at * 2 + 2], 16).unwrap()).collect()
    }

    const GENERATORS: [(Curve, &str, &str); 3] = [
        (
            Curve::P256,
            "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
            "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
        ),
        (
            Curve::P384,
            "aa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7",
            "3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f",
        ),
        (
            Curve::P521,
            "00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66",
            "011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650",
        ),
    ];

    #[test]
    fn a_point_has_to_be_on_its_curve() {
        for (curve, x, y) in GENERATORS {
            let (x, y) = (bytes(x), bytes(y));
            assert!(on_curve(curve, &x, &y), "{} generator", curve.name());
            let mut other = y.clone();
            *other.last_mut().unwrap() ^= 1;
            assert!(!on_curve(curve, &x, &other), "{} with y changed", curve.name());
            assert!(!on_curve(curve, &vec![0; x.len()], &vec![0; y.len()]), "{} at zero", curve.name());
            assert!(!on_curve(curve, &vec![0xff; x.len()], &y), "{} x past p", curve.name());
        }
    }

    fn spki(oid: &[u8], x: &[u8], y: &[u8]) -> Vec<u8> {
        // id-ecPublicKey, the curve, and the uncompressed point.
        let mut algorithm = vec![0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, oid.len() as u8];
        algorithm.extend_from_slice(oid);
        let mut point = vec![0x00, 0x04];
        point.extend_from_slice(x);
        point.extend_from_slice(y);
        let mut body = vec![0x30, algorithm.len() as u8];
        body.extend_from_slice(&algorithm);
        body.push(0x03);
        push_length(&mut body, point.len());
        body.extend_from_slice(&point);
        let mut out = vec![0x30];
        push_length(&mut out, body.len());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn an_spki_off_the_curve_is_refused() {
        let oids: [&[u8]; 3] = [&[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07], &[0x2b, 0x81, 0x04, 0x00, 0x22], &[0x2b, 0x81, 0x04, 0x00, 0x23]];
        for ((curve, x, y), oid) in GENERATORS.into_iter().zip(oids) {
            let (x, y) = (bytes(x), bytes(y));
            let parsed = parse_ec_spki(&spki(oid, &x, &y)).expect("a real point");
            assert_eq!((parsed.0, parsed.1, parsed.2), (curve, x.clone(), y.clone()));
            let mut other = y.clone();
            other[0] ^= 1;
            assert!(parse_ec_spki(&spki(oid, &x, &other)).is_none(), "{}", curve.name());
        }
    }
}
