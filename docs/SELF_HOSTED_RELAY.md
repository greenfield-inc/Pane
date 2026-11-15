# Run your own relay

Pane's relay gives each of your computers an https address that works from
any network, so phones, browsers and other computers reach them from
anywhere. Run your own and your computers use your domain and your machine
instead of Pane's servers. Everything works the same: pairing, terminals,
previews, alerts, linked computers and direct paths. The relay is one
open-source binary, `pane-relay` ([`relay/`](../relay)); its wire protocol is
[relay/PROTOCOL.md](../relay/PROTOCOL.md).

## Start one in five minutes

You need:

- A Linux machine with a public IPv4 address and Docker, such as a small
  cloud VM. This guide uses `203.0.113.10`.
- A name for the relay under a domain whose DNS you manage, such as
  `relay.example.com`. The relay answers DNS for every name under it, so use
  a name you use for nothing else.

1. **Open the ports.** In the machine's firewall or cloud security group,
   allow TCP 443, UDP and TCP 53, and UDP 7842.

2. **Add two DNS records** at the DNS provider for `example.com`:

   | Name | Type | Value |
   | --- | --- | --- |
   | `relay-ns.example.com` | A | `203.0.113.10` |
   | `relay.example.com` | NS | `relay-ns.example.com` |

   `runpane relay init` prints these records, and every command below, for
   your own name and address. It needs Node.js 22 or later and runs on any
   machine:

   ```sh
   npx --yes runpane@latest relay init --domain relay.example.com --public-ip 203.0.113.10
   ```

   On the relay machine itself you can leave out `--public-ip` when the
   machine's network interface has its public address.

3. **Start the relay** on the machine, in an empty folder:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/greenfield-inc/Pane/main/relay/compose.yaml
   printf '%s\n' PANE_RELAY_DOMAIN=relay.example.com PANE_RELAY_PUBLIC_IP=203.0.113.10 PANE_RELAY_NS=relay-ns.example.com > .env
   docker compose up -d
   ```

   If Docker says port 53 is already in use, the machine's own DNS stub
   holds it (Ubuntu and Debian run `systemd-resolved`). Turn the stub off,
   keep the machine's own lookups working, and start again:

   ```sh
   sudo mkdir -p /etc/systemd/resolved.conf.d
   printf '[Resolve]\nDNSStubListener=no\n' | sudo tee /etc/systemd/resolved.conf.d/pane-relay.conf
   sudo ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
   sudo systemctl restart systemd-resolved
   docker compose up -d
   ```

4. **Check it.** Run `relay init` again. Once DNS has spread (usually a few
   minutes), every line shows ✓ and it says the relay is ready:

   ```text
   Checks (DNS changes can take a few minutes; run this again after each step):
     ✓ relay-ns.example.com A 203.0.113.10
     ✓ relay.example.com NS relay-ns.example.com
     ✓ relay.example.com A 203.0.113.10, answered by the relay
     ✓ https://relay.example.com/healthz
   ```

   The relay gets its certificate from Let's Encrypt through its own DNS. The
   first one takes about a minute once DNS works; until then the last check
   says the certificate is not trusted yet, and `docker compose logs relay`
   shows `relay certificate issued` when it arrives. To check by hand:
   `curl https://relay.example.com/healthz` and
   `dig @203.0.113.10 relay.example.com A`.

5. **Point Pane at it.** On each computer: **Settings › Remote Access › More ›
   Relay address**, enter `relay.example.com` and press Enter. The computer
   reconnects through your relay, gets a certificate for
   `<id>.relay.example.com`, and new QR codes use your domain. Phones paired
   through Pane's servers need a new scan, and computers link only with
   computers on the same relay.

## Keep it running

The relay restarts with Docker. `docker compose pull && docker compose up -d`
updates it to the latest release. To stay on one release, add
`PANE_RELAY_VERSION=2.4.226` (any release number) to `.env`. Certificates
renew on their own, without a restart, and live in the `pane-relay` Docker
volume.

Every `pane-relay` flag also reads an environment variable, so any other
setting goes in `.env` too, such as `PANE_RELAY_ACME_EMAIL` for a Let's
Encrypt contact address. [relay/README.md](../relay/README.md#flags) lists
them all, including the connection and byte limits and the blocklist. Limits
count each client address, so a flood slows and refuses only the address it
comes from. Many computers behind one shared address, such as an office
network, may need a higher `--limit-agent-conns-per-min` and
`--limit-new-ids-per-hour`.

## Without Docker

`runpane relay` runs `pane-relay` on macOS, Linux and Windows (x64 and
arm64) with Node.js 22 or later. It downloads the binary for its own version
from the GitHub release once, checks it against the release's
`pane-relay-sha256.txt` and keeps it in your cache folder
(`~/.cache/runpane/relay`, `~/Library/Caches/runpane/relay` on macOS,
`%LOCALAPPDATA%\runpane\relay` on Windows). Its flags, output and exit code
are `pane-relay`'s. Ports 443 and 53 need root, or on Linux the
`CAP_NET_BIND_SERVICE` capability:

```sh
sudo npx --yes runpane@latest relay \
  --domain relay.example.com --public-ip 203.0.113.10 --ns relay-ns.example.com \
  --dns 0.0.0.0:53 --direct-quic 0.0.0.0:7842 \
  --acme-cache /var/lib/pane-relay/acme
```

The release also carries each binary, `pane-relay-<platform>-<arch>`, to
download yourself, and the container image is
`ghcr.io/greenfield-inc/pane-relay`. To build from source, run
`cargo build --release` in `relay/`, or `docker build -t pane-relay relay/`.

`--acme-directory` points at another CA, such as Let's Encrypt staging
(`https://acme-staging-v02.api.letsencrypt.org/directory`) while you try
things out. The relay's DNS publishes CAA records that allow only Let's
Encrypt; with another CA, set `--caa-issuer` to its domain. `--cert` and `--key` take your own certificate instead; it must
cover `relay.example.com` and `us.relay.relay.example.com` (each region's
name). `--direct-quic` is optional: it helps phones and computers find a
direct path to each other, and without it they still connect.

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

A computer alerts only phones that confirmed it: the relay pushes each phone a
grant for the computer, and the Pane app hands it back to that computer
([relay protocol](../relay/PROTOCOL.md#alerts)). Grants are signed with a key
from `--registry-secret`. Without it, grants end when the relay restarts and
phones confirm again the next time they connect.

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
