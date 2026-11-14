//! The relay's own TLS certificate for <D> and <region>.relay.<D>.

use crate::Error;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::path::Path;
use std::sync::Arc;

pub fn server_config(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<Arc<ServerConfig>, Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

pub fn load(cert: &Path, key: &Path) -> Result<Arc<ServerConfig>, Error> {
    let certs = CertificateDer::pem_file_iter(cert)
        .map_err(|e| format!("reading --cert {}: {e}", cert.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("reading --cert {}: {e}", cert.display()))?;
    let key = PrivateKeyDer::from_pem_file(key)
        .map_err(|e| format!("reading --key {}: {e}", key.display()))?;
    server_config(certs, key)
}

/// A self-signed certificate for <D>, *.<D> and *.relay.<D>. Writes its PEM to the
/// temp directory so local agents can trust it, and returns the config and that path.
pub fn dev(domain: &str) -> Result<(Arc<ServerConfig>, std::path::PathBuf), Error> {
    let names = vec![
        domain.to_string(),
        format!("*.{domain}"),
        format!("*.relay.{domain}"),
    ];
    let ck = rcgen::generate_simple_self_signed(names)?;
    let path = std::env::temp_dir().join(format!("pane-relay-dev-{domain}.pem"));
    std::fs::write(&path, ck.cert.pem())?;
    let key = PrivateKeyDer::try_from(ck.signing_key.serialize_der())?;
    Ok((server_config(vec![ck.cert.der().clone()], key)?, path))
}
