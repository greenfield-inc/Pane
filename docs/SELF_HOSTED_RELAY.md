# Run your own relay

Pane's relay is one open-source binary, `pane-relay`, in [`relay/`](../relay).
Run it on your own machine and domain, and your computers connect there
instead of Pane's servers. The wire protocol is
[relay/PROTOCOL.md](../relay/PROTOCOL.md).

## What you need

- A machine reachable from the internet on TCP 443 and on UDP and TCP 53.
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
  --public-ip 203.0.113.10
```

`pane-relay --help` and [relay/README.md](../relay/README.md) list every
flag, including connection and byte limits, the blocklist, and several
regions sharing one DNS helper (`--registry-url`, `--registry-secret`).

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
`--apns-team-id` and `--fcm-service-account`. Without them, set the keys on
each computer instead ([Native mobile](NATIVE_MOBILE.md)).

## What the relay sees

Which computer each connection is for (the TLS server name), IP addresses,
timing and byte counts. It never decrypts traffic: each computer ends TLS
with its own key. It logs no payloads, tokens or URLs.
