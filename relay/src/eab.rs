//! One-time External Account Binding keys for Google Trust Services (PROTOCOL.md, EAB keys).
//! A computer that Let's Encrypt turns away registers its own ACME account at Google Trust
//! Services, which needs an EAB key; each key registers one account. The relay mints one per
//! request through the Public CA API with the VM's service account (GCE metadata server).
//! The key's secret goes only to the computer that asked: it is never logged.

use crate::Error;
use crate::alerts::{Http, metadata_get};
use crate::config::Config;
use bytes::Bytes;
use serde_json::Value;
use std::time::{Duration, Instant};

/// Fetch a new access token this long before the cached one expires.
const TOKEN_MARGIN: Duration = Duration::from_secs(5 * 60);

pub struct Eab {
    project: Option<String>,
    /// The contact the computer registers its account with: Google Trust Services requires one.
    email: Option<String>,
    production_url: String,
    staging_url: String,
    metadata_url: String,
    http: Http,
    token: tokio::sync::Mutex<Option<(String, Instant)>>,
}

/// A computer's one-time key: `keyId` and the base64 `hmacKey` as the Public CA API returns them.
pub struct Key {
    pub key_id: String,
    pub hmac_key: String,
}

impl Eab {
    pub fn load(cfg: &Config) -> Result<Eab, Error> {
        Ok(Eab {
            project: cfg.eab_project.clone(),
            email: cfg.acme_email.clone(),
            production_url: cfg.publicca_url.trim_end_matches('/').to_string(),
            staging_url: cfg.publicca_staging_url.trim_end_matches('/').to_string(),
            metadata_url: cfg.metadata_url.clone(),
            http: Http::new(cfg.provider_ca.as_deref())?,
            token: tokio::sync::Mutex::new(None),
        })
    }

    /// The account contact to hand out with each key, when the relay has a project and an email.
    pub fn contact(&self) -> Option<&str> {
        self.project.as_ref().and(self.email.as_deref())
    }

    /// Mints a key for Google Trust Services' production CA, or its staging CA when `staging`.
    pub async fn mint(&self, staging: bool) -> Result<Key, String> {
        let project = self
            .project
            .as_deref()
            .ok_or("This relay has no --eab-project.")?;
        let token = self.access_token().await?;
        let base = if staging {
            &self.staging_url
        } else {
            &self.production_url
        };
        let url = format!("{base}/v1/projects/{project}/locations/global/externalAccountKeys");
        let headers = [("authorization", format!("Bearer {token}"))];
        let (status, body) = self.http.post(&url, &headers, Bytes::from("{}")).await?;
        if status != 200 {
            // Google's error bodies name the problem (a missing role, a disabled API) and hold no secret.
            let reason = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or_default();
            return Err(format!("the Public CA API answered {status} {reason}")
                .trim_end()
                .to_string());
        }
        let v: Value = serde_json::from_slice(&body)
            .map_err(|_| "the Public CA API answered invalid JSON".to_string())?;
        match (v["keyId"].as_str(), v["b64MacKey"].as_str()) {
            (Some(key_id), Some(hmac_key)) if !key_id.is_empty() && !hmac_key.is_empty() => {
                Ok(Key {
                    key_id: key_id.to_string(),
                    hmac_key: hmac_key.to_string(),
                })
            }
            _ => Err("the Public CA API answered no keyId and b64MacKey".to_string()),
        }
    }

    /// The service account's access token from the metadata server, cached until 5 minutes before it expires.
    async fn access_token(&self) -> Result<String, String> {
        let mut cached = self.token.lock().await;
        if let Some((token, until)) = &*cached
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let (status, body) = metadata_get(&self.metadata_url).await?;
        if status != 200 {
            return Err(format!("the metadata server answered {status}"));
        }
        let v: Value = serde_json::from_slice(&body)
            .map_err(|_| "the metadata server answered invalid JSON".to_string())?;
        let token = v["access_token"]
            .as_str()
            .ok_or("the metadata server answered no access_token")?
            .to_string();
        let lifetime = Duration::from_secs(v["expires_in"].as_u64().unwrap_or(3600));
        *cached = Some((
            token.clone(),
            Instant::now() + lifetime.saturating_sub(TOKEN_MARGIN),
        ));
        Ok(token)
    }
}
