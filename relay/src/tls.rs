//! The relay's own TLS certificate for <D> and <region>.relay.<D>, swappable
//! while running so a renewed certificate takes effect without a restart.

use crate::Error;
use rustls::ServerConfig;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use std::path::Path;
use std::sync::{Arc, RwLock};

/// The certificate every new handshake gets; `set` replaces it.
#[derive(Debug)]
pub struct Cert(RwLock<Arc<CertifiedKey>>);

impl Cert {
    pub fn set(&self, key: CertifiedKey) {
        *self.0.write().unwrap() = Arc::new(key);
    }
}

impl ResolvesServerCert for Cert {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.read().unwrap().clone())
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub fn certified_key(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<CertifiedKey, Error> {
    Ok(CertifiedKey::from_der(certs, key, &provider())?)
}

/// Parses a PEM certificate chain and PEM private key.
pub fn certified_key_pem(chain: &[u8], key: &[u8]) -> Result<CertifiedKey, Error> {
    let certs = CertificateDer::pem_slice_iter(chain).collect::<Result<Vec<_>, _>>()?;
    let key = PrivateKeyDer::from_pem_slice(key)?;
    certified_key(certs, key)
}

pub fn server_config(key: CertifiedKey) -> Result<(Arc<ServerConfig>, Arc<Cert>), Error> {
    let cert = Arc::new(Cert(RwLock::new(Arc::new(key))));
    let mut cfg = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_cert_resolver(cert.clone());
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((Arc::new(cfg), cert))
}

pub fn load(cert: &Path, key: &Path) -> Result<(Arc<ServerConfig>, Arc<Cert>), Error> {
    let certs = CertificateDer::pem_file_iter(cert)
        .map_err(|e| format!("reading --cert {}: {e}", cert.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("reading --cert {}: {e}", cert.display()))?;
    let key = PrivateKeyDer::from_pem_file(key)
        .map_err(|e| format!("reading --key {}: {e}", key.display()))?;
    server_config(certified_key(certs, key)?)
}

/// A self-signed certificate for `names`.
pub fn self_signed(names: Vec<String>) -> Result<(CertifiedKey, String), Error> {
    let ck = rcgen::generate_simple_self_signed(names)?;
    let key = PrivateKeyDer::try_from(ck.signing_key.serialize_der())?;
    Ok((
        certified_key(vec![ck.cert.der().clone()], key)?,
        ck.cert.pem(),
    ))
}

/// A self-signed certificate for <D>, *.<D>, *.relay.<D>, localhost and 127.0.0.1. Writes its PEM to the
/// temp directory so local agents can trust it, and returns the config and that path.
#[allow(clippy::type_complexity)]
pub fn dev(domain: &str) -> Result<(Arc<ServerConfig>, Arc<Cert>, std::path::PathBuf), Error> {
    let names = vec![
        domain.to_string(),
        format!("*.{domain}"),
        format!("*.relay.{domain}"),
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];
    let (key, pem) = self_signed(names)?;
    let path = std::env::temp_dir().join(format!("pane-relay-dev-{domain}.pem"));
    std::fs::write(&path, pem)?;
    let (cfg, cert) = server_config(key)?;
    Ok((cfg, cert, path))
}
