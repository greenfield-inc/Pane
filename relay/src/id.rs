//! Computer ids and the hello signature check.

use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD};
use p256::ecdsa::{DerSignature, VerifyingKey, signature::Verifier};
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use sha2::{Digest, Sha256};

/// Lowercase base32 of the first 10 bytes of sha256(SPKI DER): 16 characters of `a-z2-7`.
pub fn id_from_spki(spki_der: &[u8]) -> String {
    let hash = Sha256::digest(spki_der);
    BASE32_NOPAD.encode(&hash[..10]).to_ascii_lowercase()
}

pub fn is_valid_id(s: &str) -> bool {
    s.len() == 16
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    BASE64URL_NOPAD
        .decode(s.trim_end_matches('=').as_bytes())
        .ok()
}

pub fn b64url(bytes: &[u8]) -> String {
    BASE64URL_NOPAD.encode(bytes)
}

pub fn random_b64url<const N: usize>() -> String {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("system random source");
    b64url(&buf)
}

/// Checks the hello signature over `pane-relay-v1:<nonce>` and returns the computer's id.
/// The id is computed over the key's canonical (uncompressed) SPKI encoding.
pub fn verify_hello(spki_b64: &str, sig_b64: &str, nonce: &str) -> Result<String, &'static str> {
    let spki = b64url_decode(spki_b64).ok_or("spki is not base64url")?;
    let key = VerifyingKey::from_public_key_der(&spki).map_err(|_| "spki is not a P-256 key")?;
    let sig_der = b64url_decode(sig_b64).ok_or("sig is not base64url")?;
    let sig = DerSignature::try_from(sig_der.as_slice()).map_err(|_| "sig is not DER ECDSA")?;
    let message = format!("pane-relay-v1:{nonce}");
    key.verify(message.as_bytes(), &sig)
        .map_err(|_| "signature does not verify")?;
    let canonical = key
        .to_public_key_der()
        .map_err(|_| "spki could not be encoded")?;
    Ok(id_from_spki(canonical.as_bytes()))
}
