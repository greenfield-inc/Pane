# Runpane Cloud coordinator

The coordinator is the always-on part of `runpane cloud`. It stops idle cloud Sessions, reconciles
the provider's sandboxes against the directory of cloud Sessions, guards against runaway spend, and
answers wake requests from peers. It is a small Node service with no dependencies beyond Node's
standard library. The code lives in `packages/runpane/src/cloud/coordinator/`.

The desktop app never talks to it (#695: Pane does not create or manage cloud machines).

## Where it runs

It runs on a tiny sandbox of its own (boat `small`), joined to the tailnet as `tag:rp-session`.

- **Why a sandbox, and why that tag.** The tailnet policy lets `tag:rp-session` nodes reach only other
  `tag:rp-session` nodes. A cloud Session therefore can't reach the user's laptop or any other member
  device. A peer that needs to wake a sleeping Session must reach the coordinator, so the coordinator has
  to be an `rp-session` node itself. Tailnet members, such as the laptop, can still reach it.
- **The address it listens on.** It binds only its tailnet IP. Sandboxes have public addresses, so the
  config refuses `0.0.0.0` and `::`. WireGuard encrypts the traffic, so the API is plain HTTP on port
  47300.
- **The systemd unit.** It runs as the user unit `runpane-cloud-coordinator.service` with linger enabled.
  It never uses `pane-remote-daemon`.
- **Its token on each Session.** `runpane cloud new` pairs the coordinator as a `scope: 'coordinator'`
  client (`pane --remote-setup --client-scope coordinator`). That token may call only
  `runpane:cloud:safe-to-stop` and `runpane:cloud:upgrade` (403 `ERR_COORDINATOR_CHANNEL_FORBIDDEN`
  otherwise); `/events` and WebSocket upgrades are refused. A leaked directory can't reach panels or shells.
- **The provider key.** It holds a scoped boat key with `sandbox.read`, `sandbox.stop` and
  `sandbox.resume` only (`POST /api-keys/scoped`). There is no create, fork or delete: `runpane cloud new`
  and `destroy` run on the laptop with the unscoped key. Scope the key to the Sessions' sandbox ids when
  you can. The provider interface also has no delete method, so the code can't destroy a sandbox either.
- **State.** The coordinator keeps no state that must persist. The provider and the directory
  are the truth. Wake times and safe-to-stop streaks live in memory; losing them only makes it more
  cautious after a restart. The runaway guard's resume history (last hour) is kept in
  `<stateDir>/resumes.json`, so the service, a restarted service and `coordinator wake --local` all count
  the same resumes.

## What it does

### Idle-stop (every `idleStop.intervalSeconds`, default 300)

For each Session in the directory whose sandbox is running, the coordinator checks, in order:

1. **Recently woken?** Skip it for `wakeGraceSeconds` (default 600) after a wake that resumed the
   sandbox. Asking to wake a host that is already awake doesn't start the grace, so a peer can't keep a
   host up by asking again and again. A user's wake of an awake host restarts the safe streak (step 4); a
   peer's does not.
2. **Daemon ready?** `GET /health` must answer and report ready. If the daemon is down, don't stop the
   sandbox; raise a `daemon-down` alert instead.
3. **Safe to stop?** Call `POST /invoke runpane:cloud:safe-to-stop` with the coordinator's own paired-client
   token. The daemon refuses while an agent is working, a terminal printed output recently, a lock is
   held, a watcher is active, a PR has pending checks, or a user client is attached. When it's safe, the
   daemon also checkpoints SQLite's WAL and fsyncs. A safe answer counts only when its `flush.durable`
   is true (every flush step succeeded); otherwise the coordinator raises `idle-stop-not-checkpointed`.
4. **Enough safe answers in a row?** Stop only after `requiredConsecutiveSafe` safe answers (default 2).
   Call boat stop immediately after the last one: boat snapshots about 4 s after the stop call and then
   powers off without sending SIGTERM.

Anything other than an explicit "safe" with a durable flush resets the streak and leaves the Session
running: unsafe, a flush the daemon could not verify (or an older daemon that does not report
`durable`), an error, no answer, an old daemon without the API, or no coordinator token. A provider stop
that fails is reported as `stop-failed` with an `idle-stop-failed` alert, never as stopped.

### Reconcile (every `reconcile.intervalSeconds`, default 600)

The reconciler compares the provider's list with the directory. Only sandboxes whose name starts with
`managedNamePrefix` are considered, and never the coordinator's own sandbox or `ignoreSandboxIds`.

The reconciler **only stops and alerts. It never destroys.** It aborts without touching anything when:

- the directory can't be read (missing or invalid);
- the directory is empty while the provider lists managed sandboxes;
- the provider list fails;
- more running orphans would be stopped than `maxOrphanStopsPerRun` (default 3). A stale or truncated
  directory looks exactly like that.

If none of those apply, it stops running orphans older than `orphanGraceSeconds` (default 1800). The
grace period protects a sandbox from `runpane cloud new` that hasn't been synced to the directory yet. A
stopped orphan keeps its disk. Directory entries whose sandbox is gone or failed raise a `session-lost`
alert.

### Runaway guard

- **Live sandboxes.** The coordinator alerts when live managed sandboxes exceed `maxLiveSandboxes`
  (default 25). At that count it also refuses to wake more.
- **Resume rate.** It caps resumes per sandbox (default 6 per hour) and overall (default 60 per hour).

### Wake

The wake API returns one of five statuses; `awake` is the success answer:

| Status | Meaning |
|---|---|
| `awake` | Running, and `/health` is ready. For a daemon that reports readiness, that means `readiness.state` is not `starting`. `degraded` counts as awake and is named in `detail`. |
| `asleep` | Stopped, or stopping. |
| `waking` | A resume was sent, the sandbox is booting, or `/health` isn't ready yet. A wait that times out also returns this. |
| `daemon-down` | Running for longer than `daemonDownGraceSeconds` (default 60), but `/health` doesn't answer. |
| `lost` | The provider reports an error, or no longer has the sandbox. |

How a wake behaves:

- **One resume per sandbox.** Concurrent wakes of the same sandbox share a single resume.
- **Idle-stop in progress.** A wake that arrives while idle-stop holds the sandbox waits for it to finish.
- **Provider start limits.** On boat these are account-wide: the `box_20` plan allows 60 starts an hour
  across every create, fork and resume. With `wait`, a `429` is retried with backoff until the deadline.
  After that the wake fails with `provider-rate-limited`.
- **Pinned version.** Once awake, if `/health.version` differs from the pinned version, the coordinator
  calls `runpane:cloud:upgrade {version, url, sha256}` and waits for `/health` to report that version.
  It only upgrades when the configured `.deb` belongs to that exact version. A daemon without the upgrade
  channel is reported as `version-mismatch`, and the wake doesn't fail.

## HTTP API

Every `/cloud/*` call needs `Authorization: Bearer rpc1.<callerId>.<mac>`, where `mac` is
`base64url(HMAC-SHA256(secret, "rpc1:" + callerId))`.

- **Peer callers.** The `callerId` is a cloud Session id. A peer token stops working as soon as that
  Session leaves the directory. Peers are limited to 60 requests a minute.
- **User callers.** The `callerId` is `user:<name>`, for the laptop CLI.
- **Revoking.** Revoke one caller with `revokedCallers`, or everyone by rotating the secret.

| Endpoint | Callers | Purpose |
|---|---|---|
| `GET /health` | anyone (no auth) | liveness and the coordinator's version |
| `GET /cloud/status?host=<id\|label\|tailnet name>` | peer, user | status **without** waking (for `workspace:wait` and `panels:list`) |
| `POST /cloud/wake {host, wait=true, timeoutMs}` | peer, user | wake (for `panels:submit` only). A peer may not wake its own sandbox (403 `peer-wake-refused`) and may cause at most 2 resumes per hour (429 `wake-rate-limited`) |
| `POST /cloud/reconcile {dryRun}` | user | run a reconcile pass now |
| `POST /cloud/idle-check {dryRun}` | user | run an idle-stop pass now |
| `GET /cloud/alerts?limit=` | user | recent alerts |
| `PUT /cloud/directory` | user | replace the directory. The laptop CLI is its single writer. |
| `/cloud/github/*` | peer (bound to its node); user: `status`, `audit` | the GitHub broker, below |
| `/cloud/secrets/*` | peer (bound to its node): `fetch`, `status`; user: `status`, `audit` | the Doppler secrets service, below |

Failure responses have the form `{ok:false, code, message}`:

| HTTP status | `code` |
|---|---|
| 404 | `unknown-host` |
| 503 | `directory-unreadable` |
| 429 | `runaway-guard`, `wake-rate-limited`, `provider-rate-limited` |
| 502 | `provider-error` |

Alerts go to three places:

- stderr, which lands in the journal;
- `<stateDir>/alerts.jsonl`;
- the optional `alerts.webhookUrl`.

## Directory

The directory is a JSON file on the coordinator (0600), written through `PUT /cloud/directory`:

```json
{ "version": 1, "generatedAt": "…",
  "sessions": [ { "sessionId": "…", "label": "…", "provider": "boat", "sandboxId": "bx_…",
                  "baseUrl": "https://rp-xxxxxxxx.<tailnet>.ts.net", "nodeId": "n…",
                  "pinnedVersion": null, "coordinatorToken": "<daemon token of the coordinator's paired client>" } ] }
```

- **The `coordinatorToken`.** Bootstrap pairs a second client on each Session's daemon, labelled
  `runpane-cloud-coordinator`, and this is its token.
- **User activity.** m2's safe-to-stop exempts every `runpane:cloud:*` invoke from the user-activity
  condition, so the coordinator's own calls never keep a Session awake.
- **`github.repos`.** An optional `"github": {"repos": ["owner/name", …]}` per Session is its GitHub broker
  allowlist. `runpane cloud` writes it from the host record's `meta.brokerRepos`; no repos means no broker access.
- **`secretsManifest`.** An optional `"secretsManifest": {"repo": "owner/name", "ref": "<branch>|null"}` per
  Session says where the secrets service reads its `.runpane/secrets.json`: the repository `new --repo` cloned
  (when it is also a broker repository) at the `--ref` it started from (null: the default branch). Without
  it, a Session with exactly one broker repository uses that repository's default branch.

## GitHub broker (`/cloud/github/*`)

Cloud Sessions push branches and open pull requests, issues and comments **through the coordinator**, so no
laptop is needed at runtime and no Session ever holds a credential that can write `master`. The code is in
`packages/runpane/src/cloud/coordinator/github/` (Node standard library only; the App JWT is RS256 via
`node:crypto`). It is off until you give the coordinator a credential.

### Turning it on

```sh
runpane cloud coordinator github set --app-id <id> --private-key-file <app.pem>   # GitHub App (recommended)
runpane cloud coordinator github set --pat-file <file>                            # or a fine-grained PAT
runpane cloud coordinator github status          # mode, App, repositories, cached token expiry; never a token
runpane cloud coordinator github audit           # recent broker calls
runpane cloud coordinator github unset --yes     # off; the credential is shredded on the coordinator
```

`set` checks the credential with GitHub from your machine, then uploads it through the provider's files API
to `~/.config/runpane-cloud-coordinator/github/app.pem` (or `pat`), 0600 in a 0700 directory. It is never on
a command line, in the environment, in the provider's metadata or in this machine's settings. `set` then
rewrites the config, restarts the unit and asks the broker whether it loaded. `coordinator deploy` rebuilds
the config from the saved settings, so an in-place redeploy keeps the broker; the key file is left alone.

- **App mode.** Validation finds the installation (pass `--installation-id` if there are several) and lists
  its repositories.
  - **Refused (exit 1, nothing uploaded):**
    - the App holds Workflows, Administration or Secrets (any level);
    - the installation is on **all** repositories. An explicit *selected* list is fine, even a wide one.
  - **Warned:**
    - selected repositories beyond `--expect-repos owner/name[,…]`, or not granted to any cloud Session
      (`github.repos`). Tokens are only minted for repositories in the calling Session's allowlist, so
      these are never used;
    - every other permission beyond what the broker uses (for example `actions:write`, `statuses:write`,
      `gists`, `merge_queues`, `organization_*`), printed as `WARNING:` lines;
    - an `--expect-repos` entry that isn't installed;
    - a missing Contents, Issues or Pull requests write.
  - **Tokens.** The coordinator mints a **1-hour installation token per call**. It is narrowed to that one
    repository and to the permissions the call needs (for example `contents:write` for a push,
    `pull_requests:write` plus `contents:read` for a PR, since GitHub reads its head and base refs). It keeps them in memory only, reuses each until 5 minutes before it
    expires, and never logs them.
- **The ceiling, whatever the App was granted.** Every `access_tokens` request carries an explicit
  `permissions` object within:
  - `contents`, `issues`, `pull_requests`: read or write;
  - `metadata`: read;
  - `checks`, `statuses`, `actions`: **read only**.

  Every token beyond metadata carries `repositories:[<one>]`. An over-privileged App (for example one granted
  Actions or Commit statuses *write*) therefore never produces a token with those writes.
  - **The one exception.** `status` needs the installation's repository list, and GitHub has no App-JWT
    endpoint for it. So that list comes from a `metadata:read`-only token over the installation, used for one
    request, never cached or returned, with `status` itself cached for 10 minutes.
  - **Excess grants.** `coordinator github status` shows `WARNING` lines for excess or missing grants and for
    all-repository installations.
- **PAT mode.** Only fine-grained tokens (`github_pat_…`). Classic and OAuth tokens (`ghp_`, `gho_`, `ghu_`,
  `ghs_`, `ghr_`) reach every repository you can and are refused, on the laptop and again on the coordinator.
- **Fakes.** `--api-base-url` and `--git-base-url` point the broker at a fake GitHub (tests, and the live
  proof on the coordinator's loopback). Use `--no-verify` when your machine can't reach that URL.
- **Read paths.** `commits/:ref/status`, `commits/:ref/check-runs` and `actions/runs` need the App's
  *Commit statuses*, *Checks* and *Actions* **read** permissions. Without them the broker refuses those
  reads with `github-error` (403) before minting a token. Everything else needs only Contents, Issues and
  Pull requests (read and write) plus Metadata.

### Who may call

Every `/cloud/github/*` call from a Session needs **both**:

1. its own `rpc1` peer token (the `coordinator.token` already in the Session's `peers.json`), and
2. a TCP source address that `tailscale whois` names as **that Session's node**: the StableID matches the
   directory entry's `nodeId` (when set), the MagicDNS name matches the entry's `baseUrl` host, and the node
   carries `tag:rp-session`.

A token copied to another machine, including the coordinator itself or a tailnet member such as the
laptop, gets 403 `caller-node-mismatch`. The binding runs before anything else, even for unknown endpoints.
`tailscale whois` works for the coordinator's unprivileged user through tailscaled's read-only LocalAPI, so
no `tailscale set --operator` is needed. User callers (`user:*`) may call only `status` and `audit`.

### What a Session may do

It is an allowlist: every other path answers 404 `not-found`. There is no merge, ref delete, release,
settings, workflow dispatch, secret, collaborator or review endpoint.

| Endpoint | Body | Policy |
|---|---|---|
| `GET status` | | mode, App, repositories, `caller` = `{sessionId, host, namespace, repos}` |
| `POST token` | `{repo}` | App only: a `contents:read` token for that one repo (≤ 1 h), for fetch. PAT: 409 `read-token-unsupported` |
| `POST push` | `{repo, branch, bundle?, sha?, force?}` | writes only `refs/heads/cloud/<host>/<branch>` (below) |
| `POST pulls` | `{repo, branch, base?, title, body?, draft?}` | head is the caller's `cloud/<host>/<branch>`; **always a draft** unless `allowReadyPulls` |
| `PATCH pulls/:n` | `{repo, title?, body?, state?}` | only PRs whose head is in the caller's namespace (same repo). Any other field, such as `draft` or `base`, is 403 |
| `POST issues` | `{repo, title, body?, labels?}` | labels must already exist; unknown ones are dropped and reported |
| `PATCH issues/:n` | `{repo, title?, body?, state?}` | only issues carrying the caller's marker |
| `POST comments` | `{repo, number, body}` | any issue or PR in an allowed repo |
| `GET read/<owner>/<name>/<path>` | | `issues`, `issues/:n`, `issues/:n/comments`, `pulls`, `pulls/:n`, `pulls/:n/files`, `pulls/:n/reviews`, `commits/:ref/status`, `commits/:ref/check-runs`, `actions/runs`; query keys `state, per_page, page, branch, head, base, sort, direction, labels, event, status, since` |

- **Repositories.** Only those in the Session's directory entry (`github.repos`), else 403 `repo-not-allowed`.
- **Namespace.** `<host>` is the Session's tailnet host name (the first label of its `baseUrl`). `feature` and
  `cloud/<host>/feature` both mean `cloud/<host>/feature`. Any other `cloud/…` or `refs/…` name, and the
  default branch, `main` and `master` as branch names, are 403 `ref-outside-namespace`. Tags and deletes can't
  be expressed. `force` is allowed because the target is always the caller's own branch.
- **Workflow files.** The coordinator keeps a blobless mirror of each repository's default branch under
  `<stateDir>/github-git/`. It imports the Session's bundle there and computes the merge base of the bundle's
  head with the default branch. Any path under `.github/workflows/` that differs between the two is 403
  `workflow-change-refused`, and nothing is pushed. GitHub itself also refuses workflow changes from a
  credential without the Workflows permission, commit by commit. That refusal gets the same code.
- **Bundles.** `git bundle create - refs/heads/<b> --not origin/<default>` (exactly one ref, at most 50 MiB).
  Prerequisites the coordinator lacks are fetched from GitHub by id; a bundle built on commits GitHub doesn't
  have is 400. Without a bundle, `sha` must name a commit GitHub already has.
- **Marker.** PR, issue and comment bodies get the footer
  `Opened by runpane cloud Session <label> (<host>). <!-- runpane-cloud:<sessionId> -->`. Markers already in
  the caller's text are removed first, so a Session can't claim or hand out ownership.
- **Rate limits** (config `github.limits`): per Session 20 pushes, 60 other writes and 600 reads an hour;
  300 writes an hour across all Sessions. Over a limit: 429 `broker-rate-limited`. GitHub's own limit:
  429 `github-rate-limited`.

Errors are `{ok:false, code, message}`, plus `githubStatus` and `githubMessage` when GitHub answered:
`github-disabled` 503, `repo-not-allowed`, `ref-outside-namespace`, `workflow-change-refused`, `not-owner`,
`caller-node-mismatch` and `forbidden` 403, `not-found` 404, `read-token-unsupported` and
`non-fast-forward` 409, `bad-request` 400, `too-large` 413, `github-rate-limited` and
`broker-rate-limited` 429, `github-error` 502.

### Audit

`<stateDir>/github-audit.jsonl` (0600) gets one line per call: time, caller, label, node (name and
StableID, or the source address), endpoint, repository, target (branch or number), outcome or error code,
HTTP status, GitHub id and URL, bundle head and size, and title and body **lengths**. It never holds tokens
or text. Refused calls record what was asked for. Read it with `runpane cloud coordinator github audit`.

### Config

```json
"github": { "mode": "app", "appId": "123456", "privateKeyFile": "…/github/app.pem", "installationId": null,
            "allowReadyPulls": false, "apiBaseUrl": "https://api.github.com", "gitBaseUrl": "https://github.com",
            "limits": { "pushesPerSessionPerHour": 20, "writesPerSessionPerHour": 60,
                        "readsPerSessionPerHour": 600, "writesPerHour": 300 } }
```

`runpane cloud coordinator github set` writes it; `null` or no `github` key means the broker is off. A
credential that fails to load, such as a classic token in `patFile`, leaves the broker off; `status` shows
the reason, and the rest of the coordinator keeps running.

## Doppler secrets (`/cloud/secrets/*`)

Cloud Sessions get the Doppler secrets their repository's manifest names **from the coordinator**, at
creation and at every wake, with no laptop in the path. The code is in
`packages/runpane/src/cloud/coordinator/secrets/` (Node standard library; Doppler's REST API, no Doppler CLI).
It is off until you give the coordinator a token. User steps: [RUNPANE_CLOUD.md](RUNPANE_CLOUD.md#secrets-from-doppler-with-no-laptop-in-the-path-runpanesecretsjson).

### Turning it on

```sh
runpane cloud coordinator doppler set --project <p> --all-configs [--policy default|allow-all]   # or --config <c> ...
runpane cloud coordinator doppler set --project <p> --config <c> --token-file <file|->           # a token you made
runpane cloud coordinator doppler status [--check]     # configs, token loaded, names readable (check), policy
runpane cloud coordinator doppler policy --default | --allow-all | --deny-names A,B_* [--deny-configs prd]
runpane cloud coordinator doppler audit                # recent fetches: Session, node, manifest, names
runpane cloud coordinator doppler unset --all --yes    # shred on the coordinator, revoke in Doppler
```

- **The credential: one read-only service token per config.** Doppler scopes a service token to exactly one
  config, and `set` mints each with the laptop's logged-in `doppler` CLI (`doppler configs tokens create
  runpane-cloud-<coordinator> --access read --json`), keeping the token in memory only. A workplace with a
  handful of configs (say `dev`, `dev_personal`, `stg`, `prd`) needs a handful of tokens; `--all-configs`
  lists and mints them all. If any mint fails, the ones already minted are revoked and nothing is installed.
  `--token-file` accepts a `dp.st.` service token or a `dp.sa.` service account token (give the account a
  read-only role); personal (`dp.pt.`) and CLI (`dp.ct.`) tokens are refused, since they can write and reach
  every project.
- **On the coordinator:** each token goes through the provider's files API into the stage dir, then
  `install -m 600` to `~/.config/runpane-cloud-coordinator/doppler/<project>.<config>.token` (0700 dir) and the
  staged copy is shredded. Never a command line, the environment, provider metadata, a log or this machine's
  settings (which keep only project, config, token name and slug, so `unset` can revoke). An in-place
  `coordinator deploy` rebuilds the config from those settings and leaves the token files alone.
- **Reading Doppler:** `GET https://api.doppler.com/v3/configs/config/secrets/download?format=json&project=
  <p>&config=<c>` with the config's token. Naming the config also checks the token is the right one (Doppler
  answers 400 for any other config). Values live in memory for the one request.

### What a fetch does

`POST /cloud/secrets/fetch` from a Session (its own peer token **and** its own tailnet node, exactly as for
the GitHub broker: a copied token gets 403 `caller-node-mismatch` before GitHub or Doppler is asked):

1. **Manifest source:** the directory's `secretsManifest` (repo and ref). A ref inside the caller's own
   `cloud/<host>/` namespace is refused (403 `manifest-ref-writable`): the Session could push it itself.
2. **Manifest:** `.runpane/secrets.json` read through the GitHub broker's credential with a one-repository
   `contents:read` token (GitHub REST contents API). Absent: 200 with no configs (the Session clears its
   copy). Invalid: 422 `manifest-invalid` naming the problem.
3. **Per manifest entry:** a config the policy refuses, or one without a loaded token, is answered as
   `refused` with the reason (and not read). Otherwise the config is downloaded and narrowed to the listed
   names (`"all"`, names, `*` patterns; listed names Doppler lacks come back as `missing`), then to the
   policy: denied names and shell/Pane variables come back as `withheld` with the reason.
4. **Answer:** `{fetchedAt, manifest: {repo, ref, path, sha}, policy, configs: [{project, config, values,
   withheld, missing, refused}], version}`. `version` is a 16-hex fingerprint of the manifest sha and every
   delivered name and value together, so a Session can see that a refresh changed something.

A Doppler or GitHub failure fails the whole fetch (502 `doppler-error` / `manifest-unreadable`), so the
Session keeps its previous copy instead of losing configs. Limit: 120 fetches per Session per hour
(`secrets.limits.fetchesPerSessionPerHour`; 429 `rate-limited`). `GET /cloud/secrets/status` answers users
and peers (never a token or value; users can add `?check=1` for a names count per config). User callers may
not fetch.

### Policy (per user)

A coordinator belongs to one user (BYOK), so its policy is that user's:

| Mode | Withheld names | Refused configs |
|---|---|---|
| `default` (the product default) | `PRODUCTION_*`, `CLOUDFLARE_*`, `SHOPIFY_ADMIN*`, `VERCEL_*`, `NEON_*`, `DOPPLER_TOKEN`, `DOPPLER_*`, `*_MANAGEMENT_*` | `prd`, `prod`, `stg`, `stage`, `staging`, `production` and their branch configs |
| `allow-all` (the user's explicit choice) | none | none |
| `custom` | `deniedNames` | `deniedConfigs` |

Shell and Pane variables (`PATH`, `HOME`, `LD_*`, `PANE_*`, `RUNPANE_*`, `BASH_ENV`, ...) are withheld in
every mode.

### Audit

`<stateDir>/secrets-audit.jsonl` (0600): time, caller, label, node (name and StableID, or the source
address), endpoint, repository, ref, manifest sha, outcome or error code, HTTP status, and per config the
names delivered, withheld and missing, or why it was refused. **Never values or tokens.** The journal line
per fetch has config names and counts only. Read it with `runpane cloud coordinator doppler audit`.

### Config

```json
"secrets": { "doppler": { "apiBaseUrl": "https://api.doppler.com",
                          "tokens": [ { "project": "my-app", "config": "dev", "tokenFile": "…/doppler/my-app.dev.token" } ] },
             "policy": { "mode": "default" },
             "limits": { "fetchesPerSessionPerHour": 120 } }
```

`runpane cloud coordinator doppler set|policy|unset` write it; no `secrets` key means the service is off (503
`secrets-disabled`, which Sessions treat as "clear the copy"). A token file that fails to load (missing, or
readable by group or others) turns only that config off, with the reason in `status` and in the fetch
answer.

### In the Session

`new` (with a broker repository, when the service is on) and `runpane cloud secrets enable <host>` install:

- `~/.local/bin/doppler` (and `/usr/local/bin/doppler` unless that name is taken): runs `runpane cloud
  agent doppler`, the stand-in. It keeps the set in `~/.runpane-cloud/doppler/secrets.json` (0600, 0700 dir,
  written in place, never renamed: a boat restore can truncate a freshly renamed file) and gives values only
  to the child of `doppler run`, or to stdout for `doppler secrets get`.
- `~/.config/systemd/user/runpane-cloud-secrets.service`, a oneshot enabled for `default.target` (linger is
  on), which runs `doppler refresh --boot` at every boot: a boat wake is a boot. It retries for up to 3
  minutes while the tailnet comes up.
- A short "Secrets (Doppler)" note in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`.

Refresh rules: an outage (unreachable, 5xx) keeps the copy; a decision (`secrets-disabled`,
`manifest-invalid`, `manifest-ref-writable`, `forbidden`, unknown or revoked caller) clears it; a copy over an
hour old is refreshed before the next `doppler` command.

## Setting it up

From the laptop, `runpane cloud coordinator deploy --yes` does all of this (`packages/runpane/src/cloud/coordinatorDeploy.ts`):
it creates the sandbox from the golden image, joins it with the Session bootstrap's identity reset,
strip-list check, firewall (tailnet tcp 47300 only) and single-use `tag:rp-session` key, mints the scoped
boat key (`POST /api-keys/scoped`, stepping the lifetime down until boat accepts it), uploads this CLI's own
`dist/` and a config it writes itself (listen address = the node's tailnet IP, `selfSandboxId` = its own
sandbox), installs the unit, and writes the laptop's `coordinator.json` plus a copy of the caller secret
(`coordinator-secret`, 0600) so `new` can mint each Session's own caller token for its peers list. The laptop
CLI is the config's single writer: rerunning `deploy` rewrites it in place. `coordinator stop|start|status|destroy`
manage the sandbox; `start` re-enrols the node if a resume brought it back logged out.

The manual steps below are what `deploy` automates. They run on the coordinator sandbox after it has joined the tailnet with a single-use
`tag:rp-session` key (the Session bootstrap's `tailscale-up` step):

```sh
M="node <app>/dist/cloud/coordinator/main.js"      # or: runpane cloud coordinator
$M init --listen-host "$(tailscale ip -4)" --api-key-file ~/.config/runpane-cloud-coordinator/boat-scoped-key \
        --managed-prefix rp- --self-sandbox-id <this sandbox id>
$M install-service --entry <app>/dist/cloud/coordinator/main.js
$M mint-token user:<you> --client-config /tmp/coordinator.json --base-url http://<coordinator tailnet name>:47300
```

1. Copy `coordinator.json` to the laptop as `$RUNPANE_CLOUD_DIR/coordinator.json` (0600) and delete the
   temporary copy.
2. From the laptop, run `push-directory`, `status`, `wake`, `reconcile [--dry-run]`, `idle-check`
   and `alerts` through the API. `--local` runs them in-process on the coordinator instead.
3. Take the coordinator down or bring it back with
   `systemctl --user stop|start runpane-cloud-coordinator`. Idle Sessions then just stay awake, and peers
   can't wake sleeping Sessions until it's back.
