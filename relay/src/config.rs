use clap::Parser;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

/// `region=value` pairs given as one comma-separated flag, such as `us=1.2.3.4,eu=5.6.7.8`.
#[derive(Clone, Debug, Default)]
pub struct Pairs(pub Vec<(String, String)>);

impl Pairs {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

fn parse_pairs(s: &str) -> Result<Pairs, String> {
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (k, v) = part
            .split_once('=')
            .ok_or_else(|| format!("expected region=value, got {part:?}"))?;
        out.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    Ok(Pairs(out))
}

#[derive(Parser, Debug, Clone)]
#[command(
    name = "pane-relay",
    version,
    about = "Routes TLS by SNI to connected Pane computers, serves the relay API, and (with --dns) the domain's DNS and registry."
)]
pub struct Config {
    /// Relay domain <D>. Defaults to pane.localhost with --dev.
    #[arg(long, env = "PANE_RELAY_DOMAIN")]
    pub domain: Option<String>,

    /// This relay's region name.
    #[arg(long, env = "PANE_RELAY_REGION", default_value = "us")]
    pub region: String,

    /// TLS listen address. Defaults to 0.0.0.0:443, or 127.0.0.1:8443 with --dev.
    #[arg(long, env = "PANE_RELAY_LISTEN")]
    pub listen: Option<SocketAddr>,

    /// PEM certificate chain for <D> and <region>.relay.<D>.
    #[arg(long, env = "PANE_RELAY_CERT")]
    pub cert: Option<PathBuf>,

    /// PEM private key for --cert.
    #[arg(long, env = "PANE_RELAY_KEY")]
    pub key: Option<PathBuf>,

    /// Get the relay's certificate for <D> and <region>.relay.<D> from an ACME CA with
    /// DNS-01, keeping the account and certificate here (files mode 0600). --cert/--key win.
    #[arg(long, env = "PANE_RELAY_ACME_CACHE")]
    pub acme_cache: Option<PathBuf>,

    /// Contact email for the ACME account.
    #[arg(long, env = "PANE_RELAY_ACME_EMAIL")]
    pub acme_email: Option<String>,

    /// ACME directory URL. Let's Encrypt staging is https://acme-staging-v02.api.letsencrypt.org/directory.
    #[arg(
        long,
        env = "PANE_RELAY_ACME_DIRECTORY",
        default_value = "https://acme-v02.api.letsencrypt.org/directory"
    )]
    pub acme_directory: String,

    /// Development mode: generate a self-signed certificate when --cert/--key are absent.
    #[arg(long, env = "PANE_RELAY_DEV")]
    pub dev: bool,

    /// All regions' relay hosts, such as `us=us.relay.D,eu=eu.relay.D`. Defaults to this region only.
    #[arg(long, env = "PANE_RELAY_RELAYS", value_parser = parse_pairs, default_value = "")]
    pub relays: Pairs,

    /// IPv4 address DNS returns for <D> (and for relay names without a --region-ip).
    #[arg(long, env = "PANE_RELAY_PUBLIC_IP")]
    pub public_ip: Option<Ipv4Addr>,

    /// Each region's public IPv4 address, such as `us=1.2.3.4,eu=5.6.7.8`.
    #[arg(long, env = "PANE_RELAY_REGION_IP", value_parser = parse_pairs, default_value = "")]
    pub region_ip: Pairs,

    /// Run the helper role: authoritative DNS on this address (UDP and TCP).
    #[arg(long, env = "PANE_RELAY_DNS")]
    pub dns: Option<SocketAddr>,

    /// Name server names for the zone's NS and SOA records. Defaults to ns1.<D>,ns2.<D>.
    #[arg(long, env = "PANE_RELAY_NS", value_delimiter = ',')]
    pub ns: Vec<String>,

    /// Each name server's IPv4 address by its first label, such as `ns1=1.2.3.4,ns2=5.6.7.8`.
    /// A name server without one gets --public-ip.
    #[arg(long, env = "PANE_RELAY_NS_IP", value_parser = parse_pairs, default_value = "")]
    pub ns_ip: Pairs,

    /// Bearer secret that POST /v1/registry requires.
    #[arg(long, env = "PANE_RELAY_REGISTRY_SECRET", hide_env_values = true)]
    pub registry_secret: Option<String>,

    /// Every other helper's registry endpoint (https://<host>/v1/registry), comma-separated.
    /// Each update and a full re-post every 60 s go to all of them.
    #[arg(long, env = "PANE_RELAY_REGISTRY_URL", value_delimiter = ',')]
    pub registry_url: Vec<String>,

    /// UDP address for QUIC address discovery, which direct-path clients use to learn
    /// their public address. Clients expect port 7842. Off unless set.
    #[arg(long, env = "PANE_RELAY_DIRECT_QUIC")]
    pub direct_quic: Option<SocketAddr>,

    /// File of blocked ids, one per line; reread when it changes.
    #[arg(long, env = "PANE_RELAY_BLOCKLIST")]
    pub blocklist: Option<PathBuf>,

    /// Total open client connections; new ones beyond it are refused.
    #[arg(long, env = "PANE_RELAY_MAX_CONNECTIONS", default_value_t = 20_000)]
    pub max_connections: usize,

    /// Per computer and client address: client bytes a minute before slowing
    /// that address (refused at twice this).
    #[arg(
        long,
        env = "PANE_RELAY_LIMIT_BYTES_PER_MIN",
        default_value_t = 50_000_000
    )]
    pub limit_bytes_per_min: u64,

    /// Per computer and client address: new client connections a minute before
    /// slowing that address (refused at twice this).
    #[arg(long, env = "PANE_RELAY_LIMIT_CONNS_PER_MIN", default_value_t = 100)]
    pub limit_conns_per_min: u64,

    /// Per client address across all computers: bytes a minute before slowing (refused at twice this).
    #[arg(
        long,
        env = "PANE_RELAY_LIMIT_IP_BYTES_PER_MIN",
        default_value_t = 200_000_000
    )]
    pub limit_ip_bytes_per_min: u64,

    /// Per client address across all computers: new connections a minute before
    /// slowing (refused at twice this).
    #[arg(long, env = "PANE_RELAY_LIMIT_IP_CONNS_PER_MIN", default_value_t = 400)]
    pub limit_ip_conns_per_min: u64,

    /// Close client connections with no bytes either way for this many seconds.
    #[arg(long, env = "PANE_RELAY_IDLE_TIMEOUT_SECS", default_value_t = 600)]
    pub idle_timeout_secs: u64,

    /// SHA-256 fingerprints of the Android app's signing certificate, for assetlinks.json.
    #[arg(long, env = "PANE_RELAY_ANDROID_CERT_SHA256", value_delimiter = ',')]
    pub android_cert_sha256: Vec<String>,

    /// APNs auth key (.p8) for the Pane app; with --apns-key-id and --apns-team-id.
    #[arg(long, env = "PANE_RELAY_APNS_KEY_PATH")]
    pub apns_key_path: Option<PathBuf>,

    /// Key id of --apns-key-path.
    #[arg(long, env = "PANE_RELAY_APNS_KEY_ID")]
    pub apns_key_id: Option<String>,

    /// Apple developer team id that owns --apns-key-path.
    #[arg(long, env = "PANE_RELAY_APNS_TEAM_ID")]
    pub apns_team_id: Option<String>,

    /// The Pane app's bundle id, sent as apns-topic.
    #[arg(
        long,
        env = "PANE_RELAY_APNS_TOPIC",
        default_value = "com.dcouple.pane.mobile"
    )]
    pub apns_topic: String,

    /// Firebase service account JSON key for the Pane app's FCM sender.
    #[arg(long, env = "PANE_RELAY_FCM_SERVICE_ACCOUNT")]
    pub fcm_service_account: Option<PathBuf>,

    /// Firebase project for FCM. Alone, it sends keyless with the VM's attached
    /// service account (GCE metadata server); with --fcm-service-account it overrides that key's project.
    #[arg(long, env = "PANE_RELAY_FCM_PROJECT")]
    pub fcm_project: Option<String>,

    /// Per computer: push alerts an hour before answering `throttled`.
    #[arg(long, env = "PANE_RELAY_LIMIT_ALERTS_PER_HOUR", default_value_t = 60)]
    pub limit_alerts_per_hour: usize,

    #[arg(long, hide = true, default_value = "https://api.push.apple.com")]
    pub apns_url: String,

    #[arg(
        long,
        hide = true,
        default_value = "https://api.sandbox.push.apple.com"
    )]
    pub apns_sandbox_url: String,

    #[arg(long, hide = true, default_value = "https://fcm.googleapis.com")]
    pub fcm_url: String,

    /// The metadata server's token URL for keyless FCM (tests).
    #[arg(
        long,
        hide = true,
        env = "PANE_RELAY_FCM_METADATA_URL",
        default_value = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    )]
    pub fcm_metadata_url: String,

    /// Overrides the service account's token_uri.
    #[arg(long, hide = true)]
    pub fcm_token_url: Option<String>,

    /// Extra PEM root certificates trusted for push providers and registry helpers; its
    /// first certificate is the only root trusted for the ACME CA (tests).
    #[arg(long, hide = true)]
    pub provider_ca: Option<PathBuf>,
}

impl Config {
    pub fn domain(&self) -> Result<String, String> {
        let d = match (&self.domain, self.dev) {
            (Some(d), _) => d.clone(),
            (None, true) => "pane.localhost".to_string(),
            (None, false) => return Err("--domain is required (or pass --dev)".into()),
        };
        Ok(d.trim_end_matches('.').to_ascii_lowercase())
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen.unwrap_or_else(|| {
            if self.dev {
                "127.0.0.1:8443".parse().unwrap()
            } else {
                "0.0.0.0:443".parse().unwrap()
            }
        })
    }

    /// The public address of a region's relay: --region-ip, else --public-ip.
    pub fn region_addr(&self, region: &str) -> Option<Ipv4Addr> {
        self.region_ip
            .get(region)
            .and_then(|ip| ip.parse().ok())
            .or(self.public_ip)
    }
}
