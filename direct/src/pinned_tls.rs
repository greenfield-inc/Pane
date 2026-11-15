//! TLS to a computer's own name, trusting only the key the device paired with.
//!
//! The Pane app's requests reach `connect`'s loopback port as plain HTTP, and
//! this end opens TLS to the computer over the QUIC stream, so the computer's
//! server and its auth see the same connection as through the relay.

use std::sync::Arc;

use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tokio_rustls::TlsConnector;

/// Where `connect` opens TLS: the computer's name (SNI) and its key fingerprint.
#[derive(Clone)]
pub struct PinnedTls {
    pub connector: TlsConnector,
    pub server_name: ServerName<'static>,
}

impl PinnedTls {
    /// `fingerprint` is the base64url (no padding) SHA-256 of the computer's
    /// SubjectPublicKeyInfo DER, as pairing stores it.
    pub fn new(server_name: &str, fingerprint: &str) -> Result<PinnedTls, String> {
        let server_name = ServerName::try_from(server_name.to_string())
            .map_err(|e| format!("server name {server_name}: {e}"))?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = PinnedKey {
            fingerprint: fingerprint.to_string(),
            provider: provider.clone(),
        };
        let mut config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(PinnedTls {
            connector: TlsConnector::from(Arc::new(config)),
            server_name,
        })
    }
}

/// base64url SHA-256 of a certificate's SubjectPublicKeyInfo.
pub fn key_fingerprint(cert: &CertificateDer<'_>) -> Result<String, Error> {
    let parsed = webpki::EndEntityCert::try_from(cert)
        .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
    let digest = ring::digest::digest(
        &ring::digest::SHA256,
        parsed.subject_public_key_info().as_ref(),
    );
    Ok(data_encoding::BASE64URL_NOPAD.encode(digest.as_ref()))
}

#[derive(Debug)]
struct PinnedKey {
    fingerprint: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedKey {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if key_fingerprint(end_entity)? == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
