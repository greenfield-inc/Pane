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

The key fingerprint the Pane apps pin is base64url `sha256(SubjectPublicKeyInfo
DER)`, so its first 80 bits are the id. Apps and computers refuse a computer
whose fingerprint does not start with its id (`relayKeyMatchesId`), so a pin
saved from a scanned id always names that computer's own key, even if someone
else holds a certificate for `<id>.<D>`.

| Name | Resolves to | Served by |
| --- | --- | --- |
| `<D>` | relay apex addresses | relay API, pairing landing page, app-link files |
| `<region>.relay.<D>` | that region's relay | relay API, agent control and data connections |
| `<id>.<D>` | the relay the computer is connected to | the computer's Pane server |
| `p<port>.<id>.<D>` | same | the computer's dev server on `localhost:<port>` |
| `files.<id>.<D>` | same | the computer's preview files |
| `l<a>-<b>-<c>-<d>.<id>.<D>` | `a.b.c.d` (private ranges only) | the computer's local https listener |
| `_acme-challenge.<id>.<D>` TXT | values the computer set | DNS-01 at Let's Encrypt or Google Trust Services |
| `<D>` CAA | `issue` each CA, `issuewild ;` | no certificate for all of `*.<D>` |
| `<id>.<D>` CAA | `issue` and `issuewild` each CA, `validationmethods=dns-01` | the computer's certificate only |

The computer's certificate covers `<id>.<D>` and `*.<id>.<D>`.

Local address names answer only for RFC 1918 (`10/8`, `172.16/12`,
`192.168/16`) and CGNAT (`100.64/10`) addresses; anything else is NXDOMAIN.

A and CAA answers last 60 s and TXT answers 10 s. The names of an id the
registry does not know (a computer that was forgotten, or never connected)
answer as if it were on the answering relay, for 10 s, and that relay refuses
its clients until the computer connects. A "no such name" answer would stay cached after the
computer comes back: macOS doubles that cache time on each repeated miss,
up to more than an hour.

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
   `{"t":"error","code":"<code>","message":"<text>"}` and close. Codes:
   `bad-hello`, `bad-version`, `bad-signature`, `blocked`, `over-limit`
   (see [Limits](#limits)) and `full` (the
   registry holds `--max-computers`, all online, and this id is new).

Over the per-address control connection limit, the relay sends that
`over-limit` error in place of the challenge.

After `full`, `over-limit` or `blocked`, as an error or a `close`, Pane waits
5 minutes before connecting again. After any other failure it redials within
250 ms, then backs off to at most 10 seconds.

A second control connection for the same id replaces the first, which gets
`{"t":"close","code":"replaced"}`.

### Frames after the handshake

| From | Frame | Meaning |
| --- | --- | --- |
| relay | `{"t":"open","conn":"<base64url 16 bytes>","peer":"<ip>"}` | A client connected for one of this computer's names. Open a data connection for `conn` within 10 s. |
| computer | `{"t":"txt","req":"<n>","values":["..."]}` | Set the TXT values of `_acme-challenge.<id>.<D>` (empty list clears): at most 2 values of at most 64 bytes, what ACME needs for the name and its wildcard. More gets `bad-request`. |
| relay | `{"t":"ok","req":"<n>"}` / `{"t":"error","req":"<n>","code","message"}` | Answer to a request frame carrying `req`. |
| computer | `{"t":"eab","req":"<n>","staging":true\|false}` | A one-time EAB key for Google Trust Services; see [EAB keys](#eab-keys). |
| computer | `{"t":"local","local":["..."]}` | The computer's private addresses changed. |
| computer | `{"t":"sleep"}` | The computer is about to sleep; the relay reports it as asleep until it reconnects. |
| computer | `{"t":"grant","req":"<n>","platform":"ios"\|"android","token":"<device token>","hostProfileId":"<id>"}` | Push the phone a grant for this computer; see [Alerts](#alerts). |
| computer | `{"t":"alert","req":"<n>",...}` | Deliver a push alert with the Pane app's keys; see [Alerts](#alerts). |
| either | `{"t":"ping"}` / `{"t":"pong"}` | Keepalive. The computer pings every 5 s and redials when the relay has not answered for 8 s; the relay closes a control connection silent for 75 s. |
| relay | `{"t":"close","code":"<code>","message":"<text>"}` | The relay is cutting the computer off (`replaced`, `blocked`, `over-limit`, `shutdown`). |

## Alerts

A computer without the Pane app's push keys sends its phones' alerts through
the relay, which holds the keys. A computer alerts only a phone that confirmed
it, with a grant:

1. When a phone registers its device token, the computer sends `grant` with
   that token and the phone's id for the computer (`hostProfileId`). The phone
   registers on every connect, so while it waits the computer asks again for
   the same registration and token only 20 to 30 minutes (a random wait) after
   it last asked.
2. The relay pushes the token a silent message holding the grant,
   `<computer id>.<day>.<base64url HMAC-SHA256 over "<id>\n<platform>\n<token>\n<day>">`,
   where `<day>` is the issue day in whole days since the Unix epoch (UTC):
   on iOS a `background` push with `{"aps":{"content-available":1},"paneGrant":"<grant>","hostProfileId":"<id>"}`,
   on Android a high-priority data message with `paneGrant` and `hostProfileId`.
3. The Pane app hands the grant to the saved computer `hostProfileId` names
   (`mobile:push-grant`). That computer keeps it only if it starts with its
   own id, and sends it with every alert to that token.
4. A grant works for 30 days after its issue day. Once a grant is over 15
   days old, the computer asks for a fresh one when the phone registers or an
   alert goes out, with the same 20 to 30 minute wait between asks, and keeps
   sending the old one until the phone hands back the new one. A phone that
   stays paired and opens Pane, or gets an alert, within those 15 days
   renews without the person seeing anything.

Only the phone receives the grant, and it hands it only to a computer it is
paired with, so someone holding a leaked device token can't alert it, and a
computer the phone signed out of stops reaching it within 30 days. The
grant key comes from `--registry-secret`, so every relay that shares the
secret accepts the same grants and a computer keeps its grants when it moves
to another region. A relay without the secret makes a random key at start,
and its grants end when it restarts. An alert whose grant is missing, wrong,
over 30 days old or dated after tomorrow is refused with `unbound`; the computer then drops the grant and asks for a
new one when the phone next registers. Until it holds a grant, the computer
tells the phone it is waiting (`PUSH_AWAITING_PHONE`) instead of ready.
Each computer may send each phone at most 3 grant pushes an hour, so a
computer key asking for a leaked token spends only its own hour and never
blocks the phone's real computers. Each computer sends at most
`--limit-alerts-per-hour` grant pushes an hour in all. Grant pushes are
counted apart from alerts.

The computer builds the alert payload exactly as it would send it itself,
and adds `"grant":"<grant>"` to the frame:

- iOS: `{"t":"alert","req":"<n>","platform":"ios","token":"<APNs device token>","pushType":"alert"|"background","collapseId":"<id>","payload":{...},"grant":"<grant>"}`.
  The relay sends it to APNs with the app's topic, production first and the
  sandbox once on `BadDeviceToken`.
- Android: `{"t":"alert","req":"<n>","platform":"android","message":{...},"grant":"<grant>"}`, an
  FCM v1 `message` (with its `token`), sent with the app's sender account:
  a service account key file, or with no key the service account attached to
  the relay's Google Compute Engine VM (`--fcm-project`). A
  message without a device `token` gets `bad-request`.

The relay accepts only the fields Pane sends, and each string at most
1024 bytes; anything else gets `bad-request`:

- iOS `payload`: `eventId`, `hostProfileId`, `notifyId`, `paneId`,
  `sessionPaneId`, `panelId`, `notifyUi` (strings), `notifyClear` (boolean),
  `notifyChoices` (up to 3 strings), and `aps` with `alert` (`title`,
  `body`), `sound`, `thread-id`, `category`, and `mutable-content` or
  `content-available` set to 1.
- Android `message`: `token`, `notification` (`title`, `body`), `android`
  (`priority` `"high"`, `notification.tag`), and `data` with string values
  under `eventId`, `hostProfileId`, `notifyId`, `paneId`, `sessionPaneId`,
  `panelId`, `notifyTag`, `notifyUi`, `notifyTitle`, `notifyBody`,
  `notifyChoices` and `notifyClear`.

The relay answers `{"t":"ok","req":"<n>","status":<provider HTTP status>,"body":"<provider body, at most 2 KiB>"}`
when the provider answered, whatever its status, or
`{"t":"error","req":"<n>","code":"throttled"|"unconfigured"|"unbound"|"bad-request"|"provider","message":"..."}`.
A `grant` frame gets the same answers, except `unbound`.
Each computer may send 60 alerts an hour (`--limit-alerts-per-hour`), and
each device token may get 30 an hour from all computers together
(`--limit-alerts-per-token-per-hour`). Past either, the relay answers
`throttled` and logs one line per computer or device per hour. Payloads,
device tokens and grants are never logged.

## EAB keys

A computer orders its certificate from Let's Encrypt. When Let's Encrypt
refuses for its rate limits, it orders from Google Trust Services, which
registers an ACME account only with an External Account Binding (EAB) key,
one key per account. The computer asks its relay for one with an `eab` frame
only when it registers a new account there; later orders reuse the account.

The relay mints the key through Google's Public CA API with its VM's service
account (`--eab-project`), from the staging endpoint when `staging` is true,
and answers `{"t":"ok","req":"<n>","keyId":"...","hmacKey":"<base64>","email":"..."}`:
`email` is the relay's `--acme-email`, the contact Google Trust Services
requires on every account, so no computer sends its own.
The key goes only to the computer that asked; the relay never logs it.
Errors: `unconfigured` (no `--eab-project` or `--acme-email`), `throttled` (past
`--limit-eab-per-day` or `--limit-eab-per-hour`), `provider` (the API refused
or didn't answer within 15 s; the message says why, and the key isn't counted).
A computer counts `throttled` as Google Trust Services refusing for now, and
`unconfigured`, or no answer within 20 s, as Google Trust Services being
unavailable. The relay logs each key's id (public in every ACME request the
account signs) with the computer id, so an account can be traced to a computer.

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
| `GET /pair` | The pairing landing page (the QR's address; the secret stays in the `#fragment`). A desktop browser opens desktop Pane with `pane://pair#…`. |
| `GET /glasses` | The Wearables QR's address: the phone app opens Settings › Glasses; without the app, a page that links the iPhone app's public TestFlight beta. |
| `GET /.well-known/apple-app-site-association` | iOS universal links for `/pair` and `/glasses`. |
| `GET /.well-known/assetlinks.json` | Android app links (the app's intent filters name the paths). |
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
`POST /v1/registry` (header `authorization: Bearer <registry secret>`). The
body is one update, `{"id","region","local":[...],"txt":[...]|null,"online":true|false}` (TXT
values as the `txt` frame allows), or a JSON array of up to 5,000 of them (at most 4 MiB); `"txt":null` leaves
the TXT values as they are. The helper answers `200 {"ok":true}`, or `400`
and applies nothing when any update is malformed. A helper skips an offline
update from one region for a computer it has online in another: when a
computer moves relays, its old relay's offline update can arrive after its
new relay's online one.

Each relay keeps one queue per helper and sends it from its own task, so a
slow helper delays nothing else. Updates for the same id merge while they
wait. A computer's TXT update goes first, in a request of its own; the rest
go out together as one array. Every 60 s the relay queues all its connected
computers again, online in its own region, so a helper that restarts relearns
them and a stale entry is put right within a minute. A
TXT update (a computer's or the relay's own ACME value) succeeds once every
helper has it, or 2 s after the first one does, because the CA may ask any
helper. It fails only when every helper failed.
A helper updates its own registry in memory and lists only the other
helpers, so both helpers answer the same records.

A relay with `--acme-cache` gets its own certificate for `<D>` and
`<region>.relay.<D>` with DNS-01. It sets each challenge value on every
helper with `POST /v1/registry/acme`, body
`{"name":"_acme-challenge.<region>.relay.<D>","values":["..."]}` (the same
2 values of at most 64 bytes), and clears
it with `"values":[]` when the CA is done. On a first deploy no relay has a
real certificate yet, so these posts accept any certificate from the helper
and send no secret. Instead they carry
`authorization: Pane-HMAC <unix secs> <base64url HMAC-SHA256 with the registry secret over "pane registry acme v1\n<secs>\n<path>\n<body>">`,
which the helper accepts within 5 minutes of its clock. The helper also
still accepts the bearer secret here. Computer updates always verify the
helper's certificate. Helpers accept only
`_acme-challenge.<D>` and `_acme-challenge.<region>.relay.<D>` for a region
they know. A helper relay sets its own values in memory as well.

The zone's name servers are `ns1.<D>` and `ns2.<D>` (`--ns`); each answers
with its `--ns-ip` address, so the A records match the glue at the
registrar.

UDP answers are rate limited per client /24 (IPv6 /56): 50 a second
(`--dns-responses-per-sec`). Past it the helper answers with the header and
question only and TC=1, so a real resolver retries over TCP and a spoofed
source gets nothing larger than the query it sent. TCP answers are not
limited.

## Limits

Limits count each client by its address: an IPv4 address, or the /64 that
holds an IPv6 address. The computer and its other clients carry on whatever
one client does.

Traffic is a sustained rate, both directions together. A client over a rate
is slowed to it and never cut off: each address has a token bucket that
refills at the rate and holds one second of it, so a short burst goes at
line speed. New connections are counted a minute: past the limit each new
connection waits a second, and past twice it new connections are refused.
Open connections stay open.

- Per computer and client address: 500 Mbit/s and 100 new client connections
  a minute (`--limit-mbit-per-sec`, `--limit-conns-per-min`).
- Per client address across all computers and the iroh relay: 1,000 Mbit/s
  and 400 new connections a minute (`--limit-ip-mbit-per-sec`,
  `--limit-ip-conns-per-min`), half of what a small relay VM sends, so one
  address cannot fill a relay. Connections for a computer that is not
  connected count too.
- Per client address on the iroh relay: 500 Mbit/s and 100 new connections a
  minute (the per-computer flags), inside the address's rate above.
- Per computer, its own control connection: past 1,200 frames a minute the
  relay closes it with `over-limit` and refuses it until the minute ends.
- Per computer address, control connections: 60 a minute
  (`--limit-agent-conns-per-min`), slowed past it and refused past twice it.
  Here an IPv6 address counts by its /56, the block an ISP usually gives one
  home or small site, so a sender cannot spread over its /64s.
- Per computer address, computers new to the relay: 20 an hour
  (`--limit-new-ids-per-hour`); past it they get `over-limit`.
- Google Trust Services EAB keys: 3 a day per computer
  (`--limit-eab-per-day`) and 20 an hour per relay (`--limit-eab-per-hour`);
  past either, `eab` frames get `throttled`.
- Computers in the registry: 250,000 (`--max-computers`). A new computer in
  a full registry takes the place of the one offline longest. Only when
  every computer is online does it get `full` (a helper skips the new ids it
  is sent then).
- A computer offline for 7 days is forgotten: its names answer as an unknown
  id's (see Names) and its status `since` is null. One that never set TXT values while the
  registry knew it is forgotten after 1 hour offline. An offline computer's
  TXT values are cleared 10 minutes after it set them; an online computer
  keeps them.
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
