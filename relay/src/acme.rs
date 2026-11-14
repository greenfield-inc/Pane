//! The relay's own certificate for <D> and <region>.relay.<D> from an ACME CA
//! (Let's Encrypt by default), proven with DNS-01 through the DNS helpers.
//! Renewed when a third of its lifetime is left and swapped in without a restart.

use crate::Error;
use crate::registry::AcmeTxt;
use crate::state::State;
use crate::tls;
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount,
    NewOrder, OrderStatus, RetryPolicy,
};
use rustls::sign::CertifiedKey;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RETRY_MIN: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(3600);

pub struct Acme {
    pub cache: PathBuf,
    pub directory: String,
    pub email: Option<String>,
    /// A PEM file whose first certificate is the only root trusted for the CA (tests).
    pub ca: Option<PathBuf>,
    pub names: Vec<String>,
}

impl Acme {
    fn cert_path(&self) -> PathBuf {
        self.cache.join("cert.pem")
    }

    fn key_path(&self) -> PathBuf {
        self.cache.join("key.pem")
    }

    /// The cached certificate, or a self-signed stand-in until the first one arrives.
    pub fn initial(&self) -> Result<CertifiedKey, Error> {
        if let (Ok(chain), Ok(key)) = (
            std::fs::read(self.cert_path()),
            std::fs::read(self.key_path()),
        ) && let Ok(key) = tls::certified_key_pem(&chain, &key)
        {
            return Ok(key);
        }
        Ok(tls::self_signed(self.names.clone())?.0)
    }

    /// When the cached certificate needs renewing: a third of its lifetime before
    /// it expires. Now when there is none or it does not cover every name.
    fn renew_at(&self) -> SystemTime {
        let now = SystemTime::now();
        let Ok(pem) = std::fs::read(self.cert_path()) else {
            return now;
        };
        let Ok((_, pem)) = x509_parser::pem::parse_x509_pem(&pem) else {
            return now;
        };
        let Ok(cert) = pem.parse_x509() else {
            return now;
        };
        let covered = cert
            .subject_alternative_name()
            .ok()
            .flatten()
            .map(|san| {
                let dns: Vec<&str> = san
                    .value
                    .general_names
                    .iter()
                    .filter_map(|n| match n {
                        x509_parser::extensions::GeneralName::DNSName(d) => Some(*d),
                        _ => None,
                    })
                    .collect();
                self.names.iter().all(|n| dns.contains(&n.as_str()))
            })
            .unwrap_or(false);
        if !covered {
            return now;
        }
        let validity = cert.validity();
        let (from, until) = (
            validity.not_before.timestamp(),
            validity.not_after.timestamp(),
        );
        let renew = until - (until - from) / 3;
        UNIX_EPOCH + Duration::from_secs(renew.max(0) as u64)
    }
}

/// Keeps the certificate fresh for as long as the relay runs.
pub async fn run(state: Arc<State>, cert: Arc<tls::Cert>, acme: Acme) {
    let mut backoff = RETRY_MIN;
    loop {
        let wait = acme
            .renew_at()
            .duration_since(SystemTime::now())
            .unwrap_or_default();
        tokio::select! {
            _ = state.shutdown.cancelled() => return,
            _ = tokio::time::sleep(wait) => {}
        }
        match issue(&state, &acme).await {
            Ok(key) => {
                cert.set(key);
                backoff = RETRY_MIN;
                tracing::info!(names = ?acme.names, "relay certificate issued");
            }
            Err(e) => {
                tracing::warn!(error = %e, retry_secs = backoff.as_secs(), "relay certificate failed");
                tokio::select! {
                    _ = state.shutdown.cancelled() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(RETRY_MAX);
            }
        }
    }
}

async fn issue(state: &State, acme: &Acme) -> Result<CertifiedKey, Error> {
    let account = account(acme).await?;
    let ids: Vec<Identifier> = acme
        .names
        .iter()
        .map(|n| Identifier::Dns(n.clone()))
        .collect();
    let mut order = account.new_order(&NewOrder::new(&ids)).await?;
    let mut published = Vec::new();
    let result = async {
        let mut authorizations = order.authorizations();
        while let Some(authz) = authorizations.next().await {
            let mut authz = authz?;
            match authz.status {
                AuthorizationStatus::Pending => {}
                AuthorizationStatus::Valid => continue,
                other => return Err(format!("authorization is {other:?}").into()),
            }
            let mut challenge = authz
                .challenge(ChallengeType::Dns01)
                .ok_or("the CA offered no dns-01 challenge")?;
            let name = format!("_acme-challenge.{}", challenge.identifier()).to_ascii_lowercase();
            let values = vec![challenge.key_authorization().dns_value()];
            published.push(name.clone());
            state
                .registry
                .publish_acme(AcmeTxt { name, values })
                .await?;
            challenge.set_ready().await?;
        }
        let status = order.poll_ready(&RetryPolicy::default()).await?;
        if status != OrderStatus::Ready {
            return Err(format!("order is {status:?}").into());
        }
        let key = order.finalize().await?;
        let chain = order.poll_certificate(&RetryPolicy::default()).await?;
        Ok::<_, Error>((chain, key))
    }
    .await;
    for name in published {
        let clear = AcmeTxt {
            name,
            values: Vec::new(),
        };
        let _ = state.registry.publish_acme(clear).await;
    }
    let (chain, key) = result?;
    let certified = tls::certified_key_pem(chain.as_bytes(), key.as_bytes())?;
    write_private(&acme.key_path(), key.as_bytes())?;
    write_private(&acme.cert_path(), chain.as_bytes())?;
    Ok(certified)
}

/// The cached ACME account, or a new one saved to the cache.
async fn account(acme: &Acme) -> Result<Account, Error> {
    let builder = match &acme.ca {
        Some(ca) => Account::builder_with_root(ca)?,
        None => Account::builder()?,
    };
    let path = acme.cache.join("account.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let credentials: AccountCredentials =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok(builder.from_credentials(credentials).await?);
    }
    let contact = acme.email.as_ref().map(|e| format!("mailto:{e}"));
    let contact: Vec<&str> = contact.iter().map(String::as_str).collect();
    let (account, credentials) = builder
        .create(
            &NewAccount {
                contact: &contact,
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            acme.directory.clone(),
            None,
        )
        .await?;
    write_private(&path, serde_json::to_string(&credentials)?.as_bytes())?;
    Ok(account)
}

/// Writes a file readable only by this user, replacing it whole.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, path)
}
