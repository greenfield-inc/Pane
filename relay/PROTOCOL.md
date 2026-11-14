# Pane relay protocol, version 1

The relay gives every Pane computer an https address that works from any
network. It passes each client's TLS connection to the computer still
encrypted: the relay reads only the requested name (TLS SNI). The computer
holds its own private key and certificate and ends TLS itself.

One binary, `pane-relay`, runs two roles:

- **relay**: accepts TLS on port 443, routes by SNI, keeps one control
  connection per computer, and serves its own small https API.
- **helper** (`--dns`): authoritative DNS for the domain, and the registry of
  which region each computer is connected to. Two relays run it (say `us`
  and `eu`), so the zone has two name servers.

## Names

`<D>` is the relay domain (production: picked in P0; development: any test
domain). Every computer has an id derived from its public key:

```
id = lowercase base32 (RFC 4648, no padding) of the first 10 bytes of
     sha256(SubjectPublicKeyInfo DER of the computer's P-256 key)
```

That gives 16 characters from `a-z2-7`. Only the key holder can use the id,
so the relay needs no name registration and no database of owners.

| Name | Resolves to | Served by |
| --- | --- | --- |
| `<D>` | relay apex addresses | relay API, pairing landing page, app-link files |
| `<region>.relay.<D>` | that region's relay | relay API, agent control and data connections |
| `<id>.<D>` | the relay the computer is connected to | the computer's Pane server |
| `p<port>.<id>.<D>` | same | the computer's dev server on `localhost:<port>` |
| `files.<id>.<D>` | same | the computer's preview files |
| `l<a>-<b>-<c>-<d>.<id>.<D>` | `a.b.c.d` (private ranges only) | the computer's local https listener |
| `_acme-challenge.<id>.<D>` TXT | values the computer set | Let's Encrypt DNS-01 |

The computer's certificate covers `<id>.<D>` and `*.<id>.<D>`.

Local address names answer only for RFC 1918 (`10/8`, `172.16/12`,
`192.168/16`) and CGNAT (`100.64/10`) addresses; anything else is NXDOMAIN.

## Control connection (computer to relay)

The computer opens TLS to `<region>.relay.<D>:443` (certificate checked
normally) and sends:

```
GET /v1/agent HTTP/1.1
Host: <region>.relay.<D>
Upgrade: pane-relay/1
Connection: Upgrade
```

The relay answers `101 Switching Protocols`. From then on both sides send
newline-delimited JSON frames, one object per line, at most 64 KiB each.
Every frame has a `t` field. Unknown frame types are ignored.

### Handshake

1. relay: `{"t":"challenge","nonce":"<base64url 32 bytes>"}`
2. computer: `{"t":"hello","v":1,"spki":"<base64url SPKI DER>","sig":"<base64url DER ECDSA-SHA256 signature>","local":["192.168.1.20"],"name":"Studio Mac"}`
   The signature covers the ASCII bytes `pane-relay-v1:` followed by the
   nonce string exactly as received. `local` lists the computer's private
   IPv4 addresses (may be empty). `name` is the display name shown on the
   landing page (at most 60 characters).
3. relay: `{"t":"welcome","id":"<id>","domain":"<D>","region":"us"}`, or
   `{"t":"error","code":"<code>","message":"<text>"}` and close.

A second control connection for the same id replaces the first, which gets
`{"t":"close","code":"replaced"}`.

### Frames after the handshake

| From | Frame | Meaning |
| --- | --- | --- |
| relay | `{"t":"open","conn":"<base64url 16 bytes>","peer":"<ip>"}` | A client connected for one of this computer's names. Open a data connection for `conn` within 10 s. |
| computer | `{"t":"txt","req":"<n>","values":["..."]}` | Set the TXT values of `_acme-challenge.<id>.<D>` (empty list clears). |
| relay | `{"t":"ok","req":"<n>"}` / `{"t":"error","req":"<n>","code","message"}` | Answer to a request frame carrying `req`. |
| computer | `{"t":"local","local":["..."]}` | The computer's private addresses changed. |
| computer | `{"t":"sleep"}` | The computer is about to sleep; the relay reports it as asleep until it reconnects. |
| computer | `{"t":"alert","req":"<n>",...}` | Deliver a push alert with the Pane app's keys; see [Alerts](#alerts). |
| either | `{"t":"ping"}` / `{"t":"pong"}` | Keepalive. The computer pings every 25 s; the relay closes a control connection silent for 75 s. |
| relay | `{"t":"close","code":"<code>","message":"<text>"}` | The relay is cutting the computer off (`replaced`, `blocked`, `over-limit`, `shutdown`). |

## Alerts

A computer without the Pane app's push keys sends its phones' alerts through
the relay, which holds the keys. The computer builds the payload exactly as it
would send it itself:

- iOS: `{"t":"alert","req":"<n>","platform":"ios","token":"<APNs device token>","pushType":"alert"|"background","collapseId":"<id>","payload":{...}}`.
  The relay sends it to APNs with the app's topic, production first and the
  sandbox once on `BadDeviceToken`.
- Android: `{"t":"alert","req":"<n>","platform":"android","message":{...}}`, an
  FCM v1 `message` (with its `token`), sent with the app's sender account:
  a service account key file, or with no key the service account attached to
  the relay's Google Compute Engine VM (`--fcm-project`). A
  message without a device `token`, or with a `topic` or `condition`, gets
  `bad-request`.

The relay answers `{"t":"ok","req":"<n>","status":<provider HTTP status>,"body":"<provider body, at most 2 KiB>"}`
when the provider answered, whatever its status, or
`{"t":"error","req":"<n>","code":"throttled"|"unconfigured"|"bad-request"|"provider","message":"..."}`.
Each computer may send 60 alerts an hour (`--limit-alerts-per-hour`); past
that the relay answers `throttled` and logs one line per computer per hour.
Payloads and device tokens are never logged.

## Data connection

For each `open`, the computer opens a new TLS connection to the same relay:

```
GET /v1/data/<conn> HTTP/1.1
Host: <region>.relay.<D>
Upgrade: pane-relay/1
Connection: Upgrade
```

After `101 Switching Protocols` the stream carries the client's bytes
unchanged, starting with its TLS ClientHello, in both directions. An unknown
or expired `conn` gets `404` and close. The computer then ends the client's
TLS with its own certificate.

## Relay API (https on `<D>` and `<region>.relay.<D>`)

| Request | Answer |
| --- | --- |
| `GET /healthz` | `200 {"ok":true,"region":"us","computers":<n>}` |
| `GET /v1/relays` | `{"relays":[{"region":"us","host":"us.relay.<D>","directRelay":"https://us.relay.<D>/"},...]}` |
| `GET /v1/status/<id>` | `{"state":"online" \| "asleep" \| "offline","since":"<ISO time or null>"}` |
| `GET /pair` | The pairing landing page (the QR's address; the secret stays in the `#fragment`). |
| `GET /.well-known/apple-app-site-association` | iOS universal links for `/pair`. |
| `GET /.well-known/assetlinks.json` | Android app links for `/pair`. |
| `GET /relay`, `GET /ping` | The iroh relay for direct paths (below). |

## Direct paths

Every relay is also an [iroh](https://iroh.computer) relay, the meeting point
for direct QUIC paths between a computer and its phones and desktops
(`pane-direct` in `direct/`, ALPN `pane/direct/1`). Both ends pass the same
relay URL, the `directRelay` of the computer's region from `GET /v1/relays`:

```sh
pane-direct serve   --relay-url https://us.relay.<D>/ ...   # the computer
pane-direct connect --relay-url https://us.relay.<D>/ ...   # a phone or desktop
```

The relay serves iroh's relay protocol on its https listener: a websocket at
`/relay` and the latency probe at `/ping`. iroh endpoints prove their key to
the relay and exchange end-to-end encrypted QUIC packets through it until
they find a direct path, then send directly. `directRelay` is on port 443
unless the `--relays` host names a port (or, in `--dev`, the listener's port).

QUIC address discovery, which tells an endpoint its public address, runs on
UDP when the relay has `--direct-quic` (clients expect port 7842). Without
it, endpoints still connect, through the relay or over the addresses they
already know.

Any iroh endpoint may use the relay. Limits apply per client IP (below).

## Registry (helper)

With `--dns`, the process answers DNS for `<D>` and keeps the registry: for
each id, its region, local addresses, TXT values and last-seen time. Every
relay sends each update to every helper in its `--registry-url` list with
`POST /v1/registry` (header `authorization: Bearer <registry secret>`), body
`{"id","region","local":[...],"txt":[...]|null,"online":true|false}`, and
re-posts its connected computers every 60 s. A helper updates its own registry
in memory and lists only the other helpers, so both helpers answer the same
records, and a helper that restarts relearns them within a minute. A TXT
update succeeds once one helper has it.

The zone's name servers are `ns1.<D>` and `ns2.<D>` (`--ns`); each answers
with its `--ns-ip` address, so the A records match the glue at the
registrar.

## Limits (starting values, all flags)

- Per computer: 50 MB and 100 new client connections a minute. Over the
  limit the relay slows the computer's connections, and past twice the limit
  it closes them with `over-limit`.
- Per client IP on the iroh relay: the same 50 MB and 100 new connections a
  minute (`--limit-bytes-per-min`, `--limit-conns-per-min`). Over the limit
  the relay slows that IP's connections, and past twice the limit closes them.
- Total open client connections (`--max-connections`, default 20,000,
  counting iroh relay connections); new ones beyond it are refused.
- Idle client connections close after 10 minutes with no bytes either way.
- Blocked ids: a file (`--blocklist`), one id per line, reread when it
  changes. A blocked id's control connection gets `close` `blocked`.

## Privacy

The relay never logs or stores payload bytes, tokens or URLs. Logs carry
ids, client IPs, byte counts, timing and close reasons. On the iroh relay it
sees iroh endpoint ids and IPs; the packets it forwards are encrypted between
the endpoints.
