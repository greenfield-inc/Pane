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

    /// Name server names for the zone's NS and SOA records. Defaults to ns1.<D>.
    #[arg(long, env = "PANE_RELAY_NS", value_delimiter = ',')]
    pub ns: Vec<String>,

    /// Bearer secret that POST /v1/registry requires.
    #[arg(long, env = "PANE_RELAY_REGISTRY_SECRET", hide_env_values = true)]
    pub registry_secret: Option<String>,

    /// Helper's registry endpoint (https://<D>/v1/registry) for relays that do not run --dns.
    #[arg(long, env = "PANE_RELAY_REGISTRY_URL")]
    pub registry_url: Option<String>,

    /// File of blocked ids, one per line; reread when it changes.
    #[arg(long, env = "PANE_RELAY_BLOCKLIST")]
    pub blocklist: Option<PathBuf>,

    /// Total open client connections; new ones beyond it are refused.
    #[arg(long, env = "PANE_RELAY_MAX_CONNECTIONS", default_value_t = 20_000)]
    pub max_connections: usize,

    /// Per computer: client bytes a minute before slowing (cut at twice this).
    #[arg(
        long,
        env = "PANE_RELAY_LIMIT_BYTES_PER_MIN",
        default_value_t = 50_000_000
    )]
    pub limit_bytes_per_min: u64,

    /// Per computer: new client connections a minute before slowing (cut at twice this).
    #[arg(long, env = "PANE_RELAY_LIMIT_CONNS_PER_MIN", default_value_t = 100)]
    pub limit_conns_per_min: u64,

    /// Close client connections with no bytes either way for this many seconds.
    #[arg(long, env = "PANE_RELAY_IDLE_TIMEOUT_SECS", default_value_t = 600)]
    pub idle_timeout_secs: u64,

    /// SHA-256 fingerprints of the Android app's signing certificate, for assetlinks.json.
    #[arg(long, env = "PANE_RELAY_ANDROID_CERT_SHA256", value_delimiter = ',')]
    pub android_cert_sha256: Vec<String>,
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
