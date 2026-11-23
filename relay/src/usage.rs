//! The hourly `relay usage` line in Cloud Logging: counts only, never ids or addresses.

use crate::Error;
use crate::alerts::{Http, TokenCache, cached_token, metadata_get};
use crate::config::Config;
use crate::state::Counts;
use serde_json::json;

pub struct UsageLog {
    project: Option<String>,
    url: String,
    metadata_url: String,
    http: Http,
    token: TokenCache,
}

impl UsageLog {
    pub fn load(cfg: &Config) -> Result<UsageLog, Error> {
        Ok(UsageLog {
            project: cfg.usage_project.clone(),
            url: cfg.logging_url.trim_end_matches('/').to_string(),
            metadata_url: cfg.metadata_url.clone(),
            http: Http::new(cfg.provider_ca.as_deref())?,
            token: tokio::sync::Mutex::new(None),
        })
    }

    /// Writes one entry to `projects/<project>/logs/pane-relay-usage`; does nothing without --usage-project.
    pub async fn write(&self, region: &str, reason: &str, c: Counts) -> Result<(), String> {
        let Some(project) = &self.project else {
            return Ok(());
        };
        let token = cached_token(
            &self.token,
            "the metadata server",
            metadata_get(&self.metadata_url),
        )
        .await?;
        let body = json!({
            "logName": format!("projects/{project}/logs/pane-relay-usage"),
            "resource": {"type": "global", "labels": {"project_id": project}},
            "entries": [{
                "severity": "INFO",
                "labels": {"region": region},
                "jsonPayload": {
                    "region": region,
                    "reason": reason,
                    "computers": c.computers,
                    "computers_seen_24h": c.computers_seen_24h,
                    "clients": c.clients,
                    "client_connections": c.client_connections,
                    "computers_with_clients": c.computers_with_clients,
                },
            }],
        });
        let url = format!("{}/v2/entries:write", self.url);
        let headers = [("authorization", format!("Bearer {token}"))];
        let (status, _) = self
            .http
            .post(&url, &headers, body.to_string().into())
            .await?;
        if status != 200 {
            return Err(format!("Cloud Logging answered {status}"));
        }
        Ok(())
    }
}
