# pane-relay

The relay gives every Pane computer an https address that works from any
network. It routes each client's TLS connection by SNI to the computer's
control connection without decrypting it; the computer ends TLS with its own
certificate. With `--dns` the same binary is also the helper: authoritative
DNS for the domain and the registry of which region each computer uses.
Every relay is also an iroh relay, the meeting point for direct QUIC paths
(`https://<region>.relay.<D>/`; see [PROTOCOL.md](PROTOCOL.md#direct-paths)).

The wire protocol is [PROTOCOL.md](PROTOCOL.md).

## Build and test

```sh
cargo build --release      # target/release/pane-relay
cargo test
```

## Run locally

```sh
cargo run -- --dev --dns 127.0.0.1:5353 --public-ip 127.0.0.1
```

`--dev` uses the domain `pane.localhost`, listens on `127.0.0.1:8443`, and
writes a self-signed certificate for `pane.localhost`, `*.pane.localhost`,
`*.relay.pane.localhost`, `localhost` and `127.0.0.1` to `$TMPDIR/pane-relay-dev-pane.localhost.pem` (the
log prints the path). A local agent connects to `127.0.0.1:8443` with SNI
`us.relay.pane.localhost` and trusts that file. Check it with:

```sh
curl --cacert "$TMPDIR/pane-relay-dev-pane.localhost.pem" \
  --resolve pane.localhost:8443:127.0.0.1 https://pane.localhost:8443/healthz
dig @127.0.0.1 -p 5353 pane.localhost A
```

A local `pane-direct` uses `--relay-url https://127.0.0.1:8443/ --relay-ca
"$TMPDIR/pane-relay-dev-pane.localhost.pem"`. `tests/direct.rs` runs direct/'s
`serve` and `connect` through the relay; it builds `../direct` first, or uses
`PANE_DIRECT_BIN`.

## Flags

Every flag also reads the environment variable in brackets.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--domain` [`PANE_RELAY_DOMAIN`] | `pane.localhost` with `--dev` | The relay domain `<D>` |
| `--region` [`PANE_RELAY_REGION`] | `us` | This relay's region |
| `--listen` [`PANE_RELAY_LISTEN`] | `0.0.0.0:443` (`127.0.0.1:8443` with `--dev`) | TLS listen address |
| `--cert`, `--key` [`PANE_RELAY_CERT`, `PANE_RELAY_KEY`] | | PEM certificate and key for `<D>` and `*.relay.<D>` |
| `--dev` [`PANE_RELAY_DEV`] | off | Generate a self-signed certificate when `--cert`/`--key` are absent |
| `--relays` [`PANE_RELAY_RELAYS`] | this region | `us=us.relay.D,eu=eu.relay.D` for `GET /v1/relays` |
| `--public-ip` [`PANE_RELAY_PUBLIC_IP`] | | IPv4 that DNS returns for `<D>` and for regions without `--region-ip` |
| `--region-ip` [`PANE_RELAY_REGION_IP`] | | `us=1.2.3.4,eu=5.6.7.8`: each region's public IPv4 |
| `--dns` [`PANE_RELAY_DNS`] | off | Helper role: answer DNS on this address, UDP and TCP |
| `--ns` [`PANE_RELAY_NS`] | `ns1.<D>` | Name servers for the zone's NS and SOA records |
| `--registry-secret` [`PANE_RELAY_REGISTRY_SECRET`] | | Bearer secret for `POST /v1/registry` |
| `--registry-url` [`PANE_RELAY_REGISTRY_URL`] | | Helper's `https://<D>/v1/registry`, for relays without `--dns` |
| `--direct-quic` [`PANE_RELAY_DIRECT_QUIC`] | off | UDP address for QUIC address discovery on direct paths; clients expect port 7842, such as `0.0.0.0:7842` |
| `--blocklist` [`PANE_RELAY_BLOCKLIST`] | | File of blocked ids, one per line, reread every 5 s when it changes |
| `--max-connections` | 20000 | Total open client connections |
| `--limit-bytes-per-min` | 50000000 | Per computer, and per client IP on the iroh relay; slowed above it, cut above twice it |
| `--limit-conns-per-min` | 100 | Per computer, and per client IP on the iroh relay; slowed above it, cut above twice it |
| `--idle-timeout-secs` | 600 | Close client connections idle this long |
| `--android-cert-sha256` | | App signing fingerprints for `assetlinks.json` |
| `--apns-key-path`, `--apns-key-id`, `--apns-team-id` [`PANE_RELAY_APNS_KEY_PATH`, `PANE_RELAY_APNS_KEY_ID`, `PANE_RELAY_APNS_TEAM_ID`] | | The Pane app's APNs auth key (.p8), its key id and team id; without them iOS alerts answer `unconfigured` |
| `--apns-topic` [`PANE_RELAY_APNS_TOPIC`] | `com.dcouple.pane.mobile` | The app's bundle id, sent as `apns-topic` |
| `--fcm-service-account` [`PANE_RELAY_FCM_SERVICE_ACCOUNT`] | | Firebase service account JSON key; without it Android alerts answer `unconfigured` |
| `--limit-alerts-per-hour` | 60 | Per computer, over a sliding hour; then `throttled` |

`pane-relay --help` lists the remaining environment variable names.

## Deploy

`docker build -t pane-relay relay/` builds a non-root distroless image. Binding
port 443 or 53 as non-root works with Docker's default network (it allows
unprivileged low ports); with host networking, grant `CAP_NET_BIND_SERVICE` or
listen on a high port behind a port forward. On SIGTERM the relay sends
`close shutdown` to every computer before exiting.
