# Run your own relay

Pane's relay is one open-source binary, `pane-relay`, in [`relay/`](../relay).
Run it on your own machine and domain, and your computers connect there
instead of Pane's servers. The wire protocol is
[relay/PROTOCOL.md](../relay/PROTOCOL.md).

## What you need

- A machine reachable from the internet on TCP 443 and on UDP and TCP 53,
  plus UDP 7842 if you turn on QUIC address discovery (`--direct-quic`).
- A domain you control, say `relay.example.com`, delegated to that machine:
  an `NS` record for `relay.example.com` pointing at a name with an `A`
  record for the machine.
- A certificate for `relay.example.com` and `*.relay.relay.example.com`
  (the relay's own names). Computers get their own certificates through the
  relay's DNS.

## Run it

Build it, or use the container:

```sh
cd relay && cargo build --release
docker build -t pane-relay relay/
```

Start it with its DNS helper:

```sh
pane-relay \
  --domain relay.example.com \
  --region us \
  --listen 0.0.0.0:443 \
  --cert /etc/pane-relay/cert.pem --key /etc/pane-relay/key.pem \
  --dns 0.0.0.0:53 \
  --public-ip 203.0.113.10 \
  --direct-quic 0.0.0.0:7842
```

`--direct-quic` is optional. It helps phones and computers find a direct
path to each other; without it they still connect.

`pane-relay --help` and [relay/README.md](../relay/README.md) list every
flag, including connection and byte limits and the blocklist.

## Two name servers

Registrars usually want two name servers, and a second DNS helper keeps
names resolving while one machine is down. Run `--dns` on two relays, say
`us` at 203.0.113.10 and `eu` at 198.51.100.7, and give each the other's
registry address and the same secret:

```sh
# on us; on eu, swap the --region and the --registry-url host
pane-relay --domain relay.example.com --region us \
  --cert ... --key ... --dns 0.0.0.0:53 --public-ip 203.0.113.10 \
  --region-ip us=203.0.113.10,eu=198.51.100.7 \
  --ns-ip ns1=203.0.113.10,ns2=198.51.100.7 \
  --registry-url https://eu.relay.relay.example.com/v1/registry \
  --registry-secret "$SECRET"
```

At the registrar, delegate `relay.example.com` to `ns1.relay.example.com`
and `ns2.relay.example.com` with those two addresses as glue. A region
without `--dns` lists both helpers:
`--registry-url https://us.relay.relay.example.com/v1/registry,https://eu.relay.relay.example.com/v1/registry`.
Every relay sends each change to every helper and re-posts its computers
every minute, so both answer the same records.

Check it:

```sh
curl https://relay.example.com/healthz
dig @203.0.113.10 relay.example.com A
```

## Point Pane at it

On each computer: **Settings › Remote Access › More › Relay address**, enter
`us.relay.relay.example.com` (or `host:port`). The computer reconnects
through your relay, gets a certificate for `<id>.relay.example.com`, and new
QR codes use your domain. Phones already paired through Pane's servers need a
new scan.

## Alerts

To deliver alerts to phones from computers that have no push keys, give the
relay the Pane app's keys: `--apns-key-path`, `--apns-key-id`,
`--apns-team-id`, and `--fcm-service-account` (a service account JSON key).
Without them, set the keys on each computer instead
([Native mobile](NATIVE_MOBILE.md)).

On Google Compute Engine, Android alerts need no key file: attach the sender
service account to the VM, give the VM the `cloud-platform` access scope, and
pass `--fcm-project <project id>`. The relay gets its tokens from the VM's
metadata server.

## Direct paths

The relay is also the meeting point for direct QUIC paths between a computer
and its devices, at `https://us.relay.relay.example.com/` on the same port
443. Pane learns this address from the relay (`directRelay` in
`GET /v1/relays`), so there is nothing to configure.

## What the relay sees

Which computer each connection is for (the TLS server name), IP addresses,
timing and byte counts. It never decrypts traffic: each computer ends TLS
with its own key. It logs no payloads, tokens or URLs. Packets on direct
paths are encrypted between the two ends; the relay sees their iroh endpoint
ids, IP addresses and byte counts.
