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
- Nothing else for certificates: with `--acme-cache` each relay gets and
  renews its own from Let's Encrypt through its DNS helper, and computers get
  theirs the same way. You can pass your own with `--cert` and `--key`
  instead; it must cover `relay.example.com` and
  `us.relay.relay.example.com` (each region's name).

## Run it

With Node.js 22 or later, `runpane relay` runs the prebuilt binary for macOS,
Linux or Windows (x64 and arm64). Start it with its DNS helper:

```sh
npx --yes runpane@latest relay \
  --domain relay.example.com \
  --region us \
  --listen 0.0.0.0:443 \
  --acme-cache /var/lib/pane-relay/acme --acme-email ops@example.com \
  --dns 0.0.0.0:53 \
  --public-ip 203.0.113.10 \
  --direct-quic 0.0.0.0:7842
```

Ports 443 and 53 need root, or on Linux the `CAP_NET_BIND_SERVICE`
capability. `runpane relay` passes its flags to `pane-relay` unchanged, so the
`pane-relay` commands below work the same through it.

Or use the container: `docker build -t pane-relay relay/`, then pass the same
flags after the image name. Publish the ports above, and mount a directory for
`--acme-cache` that uid 65532 (the image's `nonroot` user) can write. To build
the binary yourself, run `cargo build --release` in `relay/`.

The first start serves a stand-in certificate for a few seconds while Let's
Encrypt checks the relay's DNS; renewals swap the new certificate in without
a restart. `--acme-directory` points at another CA, such as Let's Encrypt
staging while you try things out.

`--direct-quic` is optional. It helps phones and computers find a direct
path to each other; without it they still connect.

`runpane relay --help` and [relay/README.md](../relay/README.md) list every
flag, including connection and byte limits and the blocklist. Limits count
each client address, so a flood slows and refuses only the address it comes
from. Many computers behind one shared address, such as an office network,
may need a higher `--limit-agent-conns-per-min` and
`--limit-new-ids-per-hour`.

## Two name servers

Registrars usually want two name servers, and a second DNS helper keeps
names resolving while one machine is down. Run `--dns` on two relays, say
`us` at 203.0.113.10 and `eu` at 198.51.100.7, and give each the other's
registry address and the same secret:

```sh
# on us; on eu, swap the --region and the --registry-url host
pane-relay --domain relay.example.com --region us \
  --acme-cache /var/lib/pane-relay/acme --dns 0.0.0.0:53 --public-ip 203.0.113.10 \
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

The first time, start one helper and wait for its certificate (the log says
`relay certificate issued`) before starting the other. Relays reach a helper
over https, so it needs its certificate before others can post to it; while
the second helper is down, Let's Encrypt asks the first.

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
