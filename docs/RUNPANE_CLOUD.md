# Runpane Cloud quickstart

Runpane Cloud runs a Pane Session on its own cloud sandbox (boat.dev), with a normal Pane daemon inside,
joined to your tailnet and saved as a remote host in your Pane apps. The Session keeps running when your
laptop is closed, and you can put it to sleep (no compute billing) and wake it in about 15 to 25 seconds.
A dev server or preview an agent runs in the Session opens as a tailnet-only HTTPS link on the Session's own
name (see [Reach a service in your Session](#reach-a-service-in-your-session-ports)).

Everything here is the `runpane cloud` command on your own machine. The desktop app stays a remote
client: it lists cloud Sessions next to your other remote hosts and never creates or manages machines.

- How a sandbox is set up: [RUNPANE_CLOUD_BOOTSTRAP.md](RUNPANE_CLOUD_BOOTSTRAP.md)
- The always-on coordinator (idle-stop, wake for peers): [RUNPANE_CLOUD_COORDINATOR.md](RUNPANE_CLOUD_COORDINATOR.md)
- Daemon surface (`/health`, safe-to-stop, version pin): [RUNPANE_CLOUD_DAEMON.md](RUNPANE_CLOUD_DAEMON.md)
- Remote hosts, `--host`, peers and the phone app in general: [SELF_HOSTED_REMOTE_DAEMON.md](SELF_HOSTED_REMOTE_DAEMON.md)

## What you need

- **A boat.dev API key** (`BOAT_DEV_API_KEY`) on a paid plan with a payment method. `runpane cloud`
  creates sandboxes without a provider time limit, which boat allows only with auto-pay on.
- **A Tailscale OAuth client** with the `auth_keys` scope for `tag:rp-session`: its client id and its
  secret (`TAILSCALE_OAUTH_SECRET`). Your tailnet policy must define `tag:rp-session`. Recommended grants
  (see [Tailnet policy](#tailnet-policy)): Sessions reach each other on tcp/443 only, plus the coordinator's
  tcp/47300; your own devices also reach the [ports](#reach-a-service-in-your-session-ports) Sessions publish.
- **Tailscale on every device that uses a cloud Session**: the laptop that runs `runpane`, and your phone
  if you use the phone app. Cloud Sessions are reachable only over the tailnet.
- **Node.js 20+ and npm** on the laptop.
- Optional: an Anthropic API key for agents in cloud Sessions (see [Agents in a cloud Session](#agents-in-a-cloud-session)).

## 1. Install the CLI

Runpane Cloud is not in the npm release of `runpane` yet. Install the build from the fork's prereleases
(https://github.com/jamari-morrison/Pane/releases). Take the newest `rc-*` release whose notes say
`branch rc/integration` (others are test builds of work branches); its notes carry the exact install line:

```bash
gh release list -R jamari-morrison/Pane --limit 5      # newest first
gh release view rc-<sha> -R jamari-morrison/Pane       # check "branch rc/integration", copy the npm line
npm i -g https://github.com/jamari-morrison/Pane/releases/download/rc-<sha>/runpane-<version>.tgz
runpane version          # 2.4.141-rc.<date>.g<commit>
runpane cloud --help     # lists setup, new, list, status, stop, wake, repair, destroy, pair, sync, coordinator, peers, secrets, port, github, git, agent
```

Run `runpane cloud` from a normal terminal, not from a terminal inside Pane desktop. Pane puts its own
bundled `runpane` first on `PATH` in its terminals, and that build has no `cloud` command. From inside
Pane, call the global one by path: `"$(npm prefix -g)/bin/runpane" cloud ...`.

To go back to the npm release: `npm i -g runpane@latest`. Your cloud state in `~/.config/runpane-cloud`
is kept.

## 2. Set up your keys (once)

`runpane cloud setup` stores the keys on this machine only (`~/.config/runpane-cloud/credentials.json`,
mode 0600) and checks each one live. It takes secrets only as files or stdin (`-`), never as
command-line values, and it never prints them. Leading and trailing whitespace is trimmed, so values with
a trailing newline are fine.

With the keys in Doppler (here project `my-app`, config `dev_personal`), process substitution passes each
one as a file without writing it to disk or showing it:

```bash
D="doppler secrets get --project my-app --config dev_personal --plain"
runpane cloud setup \
  --boat-key-file <($D BOAT_DEV_API_KEY) \
  --tailscale-client-id <oauth-client-id> \
  --tailscale-secret-file <($D TAILSCALE_OAUTH_SECRET) \
  --claude-token-file <($D <Claude token name>) \
  --golden <golden-snapshot-name> \
  --name-prefix rp-dev \
  --size large
```

- Agent sign-in for cloud Sessions (see [Agents in a cloud Session](#agents-in-a-cloud-session)):
  `--claude-token-file` takes a Claude subscription token (from `claude setup-token`; in Doppler it is one of
  the `CLAUDE_CODE_DEV_*` names: `doppler secrets --project my-app --config dev_personal --only-names`);
  `--anthropic-key-file <($D ANTHROPIC_API_KEY)` takes an Anthropic API key instead. Both are optional.
- `--name-prefix` names your sandboxes and tailnet hosts `<prefix>-<id>` (default `rp`). The coordinator
  manages every sandbox whose name starts with `<prefix>-`, so pick a prefix no other sandboxes in the
  boat account use: if other tooling names its boxes `rp-ci-*`, the default `rp-` would match them.
- `--golden` names the image new Sessions start from: a boat named snapshot with the Pane daemon, Tailscale
  and Playwright's Chromium preinstalled. It makes `new` about a minute faster. Without it (`--no-golden`)
  each `new` installs everything onto the plain image. Fork builds make goldens named
  `rp-loop-golden-<sha8>` in the boat account (`scripts/cloud-dist/make-golden.sh`; list them in boat's
  console under snapshots). Releases keep only the newest two, so point `setup --golden` at a recent one:
  the one named after the `rc/integration` release you installed, or the newest if that release has none.
  `setup` saves the name without checking it exists; a missing snapshot only shows up as a create error in `new`.
- `--size` sets the default machine size; see [Costs](#costs). The built-in default is `default`
  (4 vCPU / 8 GB); `large` (8 vCPU / 16 GB) is the one to use for more than one agent with browser tests.
- Rerun `setup` with any subset of flags to change one setting. The others are kept.

Setup prints what is configured. `runpane cloud list` works after setup and says `No cloud hosts.`

## 3. Create a cloud Session

```bash
runpane cloud new --label "api work" --repo https://github.com/<you>/<repo>.git --yes
```

This takes about two and a half minutes (boat create ~1 s, running in ~4 s, then tailnet join, daemon
install and the first TLS certificate, or the switch to plain HTTP when no certificate comes; see
[HTTPS certificates and `--transport`](#https-certificates-and---transport)). It:

1. creates a sandbox named `rp-<8 chars>` (the same name is its tailnet host name; `setup --name-prefix`
   changes `rp`);
2. turns on a host firewall that lets only tcp/443 (Tailscale Serve) in over the tailnet, then joins your
   tailnet as `tag:rp-session`, with a single-use key and Tailscale SSH off;
3. starts the Pane daemon, reachable at `https://rp-<id>.<your-tailnet>.ts.net` (or
   `http://rp-<id>.<your-tailnet>.ts.net:42137` when it fell back to plain HTTP; `new` prints which);
4. clones `--repo` (a public HTTPS repository, or a private GitHub one with `--github`: see
   [GitHub access](#8-github-access-private-repositories-and-pushing); add `--ref <branch>` for a branch) into
   `/home/user/<repo>` and registers it with the Session's Pane, so `runpane --host <Session> panes create
   --repo <repo> ...` works right away (full command under [From the CLI](#from-the-cli));
5. saves the host in `~/.config/runpane-cloud/hosts/` and the pairing code in
   `~/.config/runpane-cloud/hosts/<host>.pairing` (0600, never printed);
6. adds the host to Pane desktop's saved remote hosts, if `~/.pane/config.json` exists (with `--desktop-dir`
   or `RUNPANE_CLOUD_DESKTOP_DIR` set it always writes there, creating `config.json` if needed).

`--yes` is required because the sandbox costs money. `--size large` overrides the default size for one
Session. If setup fails part-way, `new` deletes the tailnet device and the sandbox again; add
`--keep-on-failure` to keep them for debugging.

```bash
runpane cloud list                 # every cloud Session with its state
runpane cloud status "api work"    # awake | asleep | waking | stopping | daemon-down | lost
```

A cloud Session can be named by its host name (`rp-...`), cloud Session id, label or sandbox id
everywhere below.

## 4. Use it

### Pane desktop

`new` already added the host. In Pane desktop, open the remote host switcher in the sidebar and pick it:
you get an ordinary remote Pane (agent panels, terminals, diffs). One remote host is active at a time.

> **Released (upstream) Pane desktop builds: quit the app first.** `new`, `sync` and `destroy` edit the
> desktop's saved remote hosts on disk (`~/.pane/config.json`). A released desktop that is running doesn't
> notice that edit, so the host doesn't show up. Worse, the app's next settings save (any toggle) writes its
> old copy back and **erases the hosts `runpane cloud` added** (`remoteDaemon.client.profiles` becomes empty).
> Until your desktop has the fix:
>
> 1. Quit Pane desktop completely (on macOS: Pane > Quit, not just closing the window).
> 2. Run `runpane cloud new`, `sync` or `destroy`.
> 3. Reopen Pane desktop and check that the host is listed in the switcher. If it isn't, quit again and run
>    `runpane cloud sync`.
>
> Or leave the desktop running and import through the app itself, which is safe: `runpane cloud new
> --no-import ...`, then `runpane cloud pair <host>` and paste the code into `Settings > Remote Access >
> Connections > Connection code`, then click **Import & Connect**.
>
> The fix (commit `cd190659`: the desktop now picks up outside edits live and never writes over them) is in
> fork builds from `rc/integration` at `080d3828` or later. The cloud prerelease ships the desktop as a
> **Linux `.deb` only**, so an installed macOS or Windows desktop needs the workaround until an upstream
> release has it. A fork `.deb` desktop shows a "Software Update" prompt for the upstream release on launch.
> Dismiss it: updating would replace the fork build.
>
> To try the fix on Windows or macOS without touching an installed Pane, use a **side-by-side test build**:
> the fork prerelease `rc-desktop-<sha8>` from `.github/workflows/rc-desktop.yml` (unsigned zips). It keeps
> its data in `~/.pane_cloudtest`, runs next to the installed Pane, registers nothing machine-wide (no login
> item, `pane://` handler, agent MCP servers or skills) and never offers updates. Remove it by deleting its
> folder and `~/.pane_cloudtest`.

If Pane desktop was not installed yet, or you use another data directory, add every cloud Session later
with:

```bash
runpane cloud sync                           # into ~/.pane
runpane cloud sync --desktop-dir <pane dir>  # somewhere else
```

For a desktop on another machine, print the pairing code and paste it into `Settings > Remote Access >
Connections > Connection code` there, then click **Import & Connect**:

```bash
runpane cloud pair "api work"     # prints the pane-remote:// code; treat it like a password
```

### Phone

1. Install Tailscale on the phone and sign in to the same tailnet.
2. Open https://runpane.com/app/ (on iPhone: Safari, Share, Add to Home Screen).
3. Paste the code from `runpane cloud pair <host>`.

The phone app needs the Session on HTTPS: it can't open an `http://` Session (see
[HTTPS certificates and `--transport`](#https-certificates-and---transport)).

### From the CLI

Every daemon command takes `--host <cloud Session>`:

```bash
runpane --host "api work" repos list --json
runpane --host "api work" panes create --repo <repo> --name first --agent claude \
  --prompt "Say hello" --yes --json     # prints the new panelId
runpane --host "api work" panels list
runpane --host "api work" panels output --panel <panel id> --limit 200 --json
runpane --host "api work" panels submit --panel <panel id> --text "npm test" --yes
```

Commands that change the Session's Pane (`panes create`, `panels submit`) need `--yes` when run from a
script or another non-interactive shell.

### Agents in a cloud Session

Agents run inside the sandbox, so they need their own sign-in there. Save one with `runpane cloud setup`:
`--anthropic-key-file <file|->` (an Anthropic API key) or `--claude-token-file <file|->` (a Claude
subscription token from `claude setup-token`). Every later `new` writes it into the sandbox as a 0600
environment file for the Pane daemon (never on a command line) and pre-answers Claude Code's first-run
prompts, so a Claude panel works right away. Without either, open a terminal in the cloud Session and run
`claude` once to log in; that sign-in lives on the sandbox disk and survives sleep and wake.

`new` marks only the repository it cloned (`--repo`) as trusted for Claude Code. Trust is per repository
root, and trusting `/home/user` does not cover folders under it. The first Claude panel in a repository you
add later (`runpane --host <Session> repos add --path ...`) stops at Claude's "Do you trust this folder?"
dialog, whose default answer exits Claude. Answer it from the CLI: send Down, then Enter.

```bash
printf '\033[B' | runpane --host "api work" panels input --panel <panel id> --input-file - --yes
printf '\r'     | runpane --host "api work" panels input --panel <panel id> --input-file - --yes
```

Later panels in that repository, including new worktrees, start without the dialog.

The sandbox has no git identity, so an agent's `git commit` fails with "Author identity unknown" until you
set one: `git config --global user.name ...` and `user.email ...` in a terminal in the Session.

Agents in the Session are told how to show you what they run: the Session's Pane daemon keeps a short block
in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (between `<!-- runpane-cloud-ports:start -->` and
`<!-- runpane-cloud-ports:end -->`) saying to publish any web service with `runpane port open <port> --name
<name>` and to paste the printed `https://` URL, never a `localhost` address. Ask an agent to "start the dev
server and give me the link" and you get a link that opens on your laptop and phone (see
[Reach a service in your Session](#reach-a-service-in-your-session-ports)).

Your own rules for agents go in the same files, in every Session. Pane ships none; you add them once on
your machine:

```bash
runpane cloud notes add "Ask me before deleting data, running migrations or deploying anything."
runpane cloud notes list
runpane cloud notes remove 1
runpane cloud notes push [<host>]    # hand the current list to a Session (default: all) now
```

The list is `agentNotes.guardrails` in `~/.config/runpane-cloud/settings.json`. `add` and `remove` push it to
every awake Session, `new` and `wake` push it, and an asleep Session keeps its previous list until then.
Each Session's daemon keeps the copy it was given (`~/.runpane-cloud/agent-notes.json`) and writes it as a
`runpane-cloud-guardrails` block at every boot and wake, so an agent that edits those files gets it back.

### Secrets from Doppler, with no laptop in the path (`.runpane/secrets.json`)

If your team keeps secrets in Doppler, let the coordinator hold **read-only Doppler service tokens** and let
each repository say which names its Sessions get. Every new Session on that repository then has them at
creation, and gets a fresh copy at every wake, without your laptop.

**Once, on your machine** (logged in to Doppler with `doppler login`):

```bash
# mint one read-only service token per config with your doppler CLI; each goes 0600 onto the coordinator
runpane cloud coordinator doppler set --project my-app --all-configs          # or --config dev [--config stg ...]
runpane cloud coordinator doppler status --check                              # each config: token loaded, N names readable
# optional: what the coordinator withholds (per user; the default is the built-in deny-list below)
runpane cloud coordinator doppler policy --allow-all                          # everything the manifest names, production included
```

**Once per repository**, commit `.runpane/secrets.json` (names, never values):

```json
{
  "version": 1,
  "doppler": [
    { "project": "my-app", "config": "dev", "names": "all" },
    { "project": "my-app", "config": "dev_personal", "names": ["OPENROUTER_API_KEY", "R2_*"] }
  ]
}
```

`names` is `"all"` or a list of names and `*` patterns. The first entry is what `doppler run` uses without
`-p`/`-c`. Put the file on the branch Sessions start from (the default branch unless you pass `new --ref`).

**Then every Session on it just works:**

```bash
runpane cloud new --repo https://github.com/<owner>/<repo> --github --yes
#   - secrets done: doppler stand-in installed; my-app/dev 91 names, my-app/dev_personal 2 names from <owner>/<repo>:.runpane/secrets.json
```

Inside the Session, agents (and you) use Doppler as the repository's docs already say:

```bash
doppler run -- bun test                        # the config's secrets in that command's environment only
doppler run -p my-app -c dev_personal -- node x.js
doppler secrets get OPENROUTER_API_KEY --plain  # one value, when a tool needs it on stdin
doppler secrets --only-names                   # names only
doppler status                                 # which manifest (repo, ref, sha), fetched when, what was withheld
doppler refresh                                # fetch again now (after a manifest or Doppler change)
```

`doppler` in a Session is a stand-in (`~/.local/bin/doppler`, which runs `runpane cloud agent doppler`); the
Session holds no Doppler token and needs no `doppler login`. It serves `run` (`-p/--project`, `-c/--config`,
`--command`, `--preserve-env`), `secrets get` (`--plain`, `--json`), `secrets download --no-file --format
json|env`, `secrets --only-names`, `refresh`, `status` and `configs`; `setup` and `login` are no-ops. Anything
else exits 2.

- **How values travel:** the Session asks the coordinator (`POST /cloud/secrets/fetch`, its own caller token
  plus its tailnet node, like the GitHub broker). The coordinator reads `.runpane/secrets.json` from GitHub
  with the broker's credential, at the ref the Session was created from, reads each config from Doppler with
  its service token, applies your policy and answers over the tailnet. The Session keeps the set in
  `~/.runpane-cloud/doppler/secrets.json` (0600, 0700 directory). Values reach a process only as the
  environment of the child of `doppler run`, or on stdout for `doppler secrets get`: never a shell rc file,
  the daemon's environment, boat metadata, a command line or a log. They never pass through your laptop.
- **When it refreshes:** at every boot, which includes every wake (a user unit,
  `runpane-cloud-secrets.service`, runs `doppler refresh --boot`); on `doppler refresh`; and before a
  `doppler` command when the copy is over an hour old. If the coordinator or Doppler is briefly away, the
  Session keeps its copy. A decision clears it: the manifest removed or invalid, the service turned off,
  the Session removed from the directory. Removing a name from the manifest removes it at the next refresh.
- **Policy (per user, on your coordinator):** `default` withholds `PRODUCTION_*`, `CLOUDFLARE_*`,
  `SHOPIFY_ADMIN*`, `VERCEL_*`, `NEON_*`, `DOPPLER_*`, `*_MANAGEMENT_*` and refuses `stg`/`prd`-style
  configs; `allow-all` delivers every name the manifest lists (your call: production credentials then reach
  your agents); `--deny-names A,B_* --deny-configs prd` is a custom list. Shell and Pane variables (`PATH`,
  `LD_*`, `PANE_*`, ...) are never delivered. `doppler status` in the Session lists what was withheld and why.
- **Manifest safety:** the coordinator refuses a manifest read from the Session's own `cloud/<host>/`
  namespace (the Session could push it and widen its own grant): keep it on a branch people review.
- **Audit:** `runpane cloud coordinator doppler audit` shows every fetch: Session, node, manifest (repo, ref,
  sha), and the names delivered or withheld. Never values.
- **Existing Sessions:** `runpane cloud secrets enable <host>` installs the stand-in and fetches once
  (it needs a Session whose Pane has `cloud agent doppler`); `runpane cloud secrets disable <host>` removes it
  and shreds the copy.
- **Disconnect:** `runpane cloud coordinator doppler unset --all --yes` shreds the tokens on the coordinator
  and revokes (in Doppler) the ones your machine minted. Sessions drop their copy at their next refresh.

### Other secrets for agents (`cloud secrets`)

Agents often need more keys than the sign-in: a model router, a test service, a read-only token. Without a
Doppler-backed coordinator (above), give them to one Session with `runpane cloud secrets`. Values are read
**on your machine**, so nothing else ever has to hold them:

```bash
# from Doppler, through your local doppler CLI (dev configs only)
runpane cloud secrets set rp-a1b2c3d4 OPENROUTER_API_KEY --from-doppler my-app/dev
# from this shell's variable of the same name (the default), or another variable, or a file / stdin
runpane cloud secrets set rp-a1b2c3d4 SENTRY_DSN LINEAR_API_KEY
runpane cloud secrets set rp-a1b2c3d4 GITHUB_READ_TOKEN --from-env MY_READ_ONLY_PAT
runpane cloud secrets set rp-a1b2c3d4 SERVICE_ACCOUNT_JSON --from-file ./sa.json
runpane cloud secrets list rp-a1b2c3d4          # names only; values are never shown
runpane cloud secrets rm rp-a1b2c3d4 LINEAR_API_KEY
```

- **Where they go:** a staged file written through boat's files API, which a script in the sandbox merges
  into `~/.runpane-cloud/secrets.env` (0600, in a 0700 directory) and then shreds. Values are never in
  boat's sandbox metadata or environment, on a command line, or in a log.
- **Who sees them:** every panel shell started after the change. A block at the top of `~/.bashrc` and
  `~/.zshenv` loads the file, so a new Claude or Codex panel has them without restarting the daemon.
  Panels that were already open keep the environment they started with: open a new panel. `rm` works the
  same way.
- **Refused names:** production, infrastructure and secret-manager credentials never enter a Session:
  `PRODUCTION_*`, `CLOUDFLARE_*`, `SHOPIFY_ADMIN*`, `VERCEL_*`, `NEON_*`, `DOPPLER_TOKEN` (and any
  `DOPPLER_*`), `*_MANAGEMENT_*`, plus shell and Pane variables such as `PATH` or `PANE_*`. The check also
  covers the name read with `--from-env`, and happens before anything is sent. Add your own patterns in
  `~/.config/runpane-cloud/settings.json`: `"secretsDenyList": ["E2B_*", "STRIPE_SECRET_KEY"]`.
- **`--from-doppler` refuses** configs named `prd`, `prod`, `stg`, `stage`, `staging` or `production`
  (and branch configs of them such as `prd_hotfix`). A dev config can still hold production values:
  pick names one by one, never "everything in the config".
- The Session must be awake (`runpane cloud wake <host>` first). Secrets live on its disk and survive
  sleep and wake; `destroy` deletes them with the disk.

### Reach a service in your Session (ports)

A dev server, a preview app, Storybook or any other web service that you or an agent run in a cloud Session
gets a **tailnet-only HTTPS link on the Session's own name**:

```
https://<host>.<your-tailnet>.ts.net:<port>/
```

The link opens in any browser, Safari included, on every device in your tailnet: your laptop, your phone, a
colleague's Mac. You don't need a forwarder, `localhost` tricks or an admin-console change. This is the
**default way to reach a Session's services**. It uses Tailscale Serve, **never Funnel**, so nothing is on the
public internet. Your tailnet policy decides which devices may open it (see [Tailnet policy](#tailnet-policy)).

#### Open, list and close a port

**Inside the Session** (a terminal in the Session, or an agent; no laptop needed):

```bash
npm run dev -- --port 5173 --host 127.0.0.1    # your service, listening on 127.0.0.1 or 0.0.0.0
runpane port open 5173 --name web
# Published web: https://rp-a1b2c3d4.tail1234.ts.net:5173/
runpane port list                              # add --verify to request each URL from the Session
runpane port close web                         # by name or by local port
```

Vite and webpack dev servers refuse host names they don't know ("Blocked request. This host is not allowed",
"Invalid Host header"), and the link arrives with the Session's name as its host. Allow it once in the project:
Vite `server: { allowedHosts: ['.ts.net'] }`, webpack-dev-server `allowedHosts: ['.ts.net']`.

`port list` prints:

```
Ports on rp-a1b2c3d4.tail1234.ts.net (tailnet only):
  NAME       PORT  URL                                        SOURCE    STATUS
  web        5173  https://rp-a1b2c3d4.tail1234.ts.net:5173/  user      serving
  api        3000  https://rp-a1b2c3d4.tail1234.ts.net:3000/  manifest  serving
  storybook  6006  https://rp-a1b2c3d4.tail1234.ts.net:8443/  user      serving
Suggested (listening under a Pane panel, not published):
  9229 on 127.0.0.1 (node): runpane port open 9229
Manifest /home/user/my-app/.runpane/ports.json: 1 port(s)
Auto-open: off
```

**From the laptop**, name the Session as in every other `runpane cloud` command:

```bash
runpane cloud port open "api work" 5173 --name web
runpane cloud port open "api work" 6006 --name storybook --https-port 8443
runpane cloud port list "api work"          # also requests each URL from this machine (REACHABLE column)
runpane cloud port close "api work" web
```

**In Pane** (desktop, the web client and the phone app), published ports show as a **Ports** row of chips:

- **Where:** under the tab bar of a Session in Pane desktop, in the Pane Chat header, and under the host bar of the web
  client (https://runpane.com/app/; on a phone the row scrolls sideways).
- **A published port** is a chip, `name :port`. Click the name to open the URL: in your default browser from the desktop,
  in a new tab from the web client. The copy button copies the URL; the × asks, then stops publishing it. An amber dot
  means the daemon can't serve it right now (hover for why); an `http` tag means the Session has no TLS certificate and
  the link is plain HTTP inside the tailnet.
- **A suggested port** (dimmed, dashed) is something a panel started listening on that isn't published. **Open on
  tailnet** publishes it. If that tailnet port is already taken by another Serve entry, the row asks before replacing it.
- The row follows the daemon you're connected to: it updates when ports change, when the connection comes back, and every
  30 s. Switching hosts or losing the connection clears it at once, together with any question it was asking, so a
  Close or Replace never reaches a host other than the one whose chip you clicked. It stays hidden off a cloud Session
  and on daemons without ports support. If the first read fails, the row says why and offers **Retry**; a copy the
  clipboard refuses says so too.

#### How a published port behaves

- **The URL.** The tailnet port defaults to the service's own port, so `5173` becomes `https://<host>:5173/`,
  which is stable and guessable. `--https-port` picks another. `:443` stays Pane's own, and so does the
  daemon's port (42137). `--name` defaults to `port-<port>` (lowercase letters, digits and hyphens).
- **The path is the service's to handle.** `--path /s/demo` only changes the link that is printed and shown.
  Tailscale Serve publishes the whole tailnet port (`tailscale serve --https=<tailnet port> http://127.0.0.1:<port>`)
  and passes every request path through unchanged, so opening the link sends `GET /s/demo` to the service.
  Nothing strips or rewrites the path: the service must answer `/s/demo` itself (for example a dev server's
  base path setting). Every other path on that port reaches the service too.
- **Running `open` again** for a port that is already published prints `Already published` with the same URL.
- **The service can start later.** A port can be published before anything listens on it. Its URL answers
  502 until the service starts, and the link stays the same.
- **Replacing an older entry.** If another Tailscale Serve entry already holds the tailnet port (for example a
  plain `tailscale serve --tcp` forward set up by hand), `open` refuses and names it. `--yes` replaces it.
  An identical HTTPS entry (`tailscale serve --https=P http://127.0.0.1:P`) is simply adopted.
- **The service sees who is asking.** Tailscale Serve passes the browser's `Host`
  (`rp-a1b2c3d4.tail1234.ts.net:5173`) through to the service, adds `X-Forwarded-Host` and
  `X-Forwarded-Proto: https`, and adds [identity headers](https://tailscale.com/s/serve-headers)
  (`Tailscale-User-Login`, `Tailscale-User-Name`) for requests from a person's device.
- **Survives restarts, sleep and wake.** The Session's Pane daemon keeps the list in
  `~/.runpane-cloud/ports.json` (0600). At every boot (a wake is a boot), after a daemon restart and once a
  minute, it re-applies any entry Tailscale Serve lost. At boot it also requests each URL and logs the answer.
- **Opening a link doesn't wake a sleeping Session, and doesn't keep one awake.** Wake it first
  (`runpane cloud wake <host>`). The coordinator's idle-stop counts Pane clients, agents, terminal output and
  locks, not browser visits to a port. To keep a Session up while someone reviews, keep a Pane client attached
  or hold a lock in the Session: `runpane lock acquire --name review --ttl 2h` (and `runpane lock release --name
  review` when you're done).

#### Several ports, several Sessions: no clashes

- **In one Session**, every published port has its own tailnet port on the Session's name, and one
  certificate for the name covers them all. Two services can't share a tailnet port: `open` answers
  `ERR_PORTS_IN_USE` and you pick another with `--https-port`.
- **Across Sessions**, each Session has its own name, so the same port number never clashes.
  `https://rp-a1b2c3d4.<tailnet>.ts.net:8787/` and `https://rp-e5f6a7b8.<tailnet>.ts.net:8787/` are two
  different links that work side by side, and so do two Sessions running the same repository with the same
  `.runpane/ports.json`.
- **Nothing is published on your laptop.** `runpane port` only works in a Runpane Cloud Session. On any other
  machine it prints `Session ports are not available here` and never touches that machine's tailnet name.

#### Declare them in the repository (`.runpane/ports.json`)

Commit the services a repository runs, and every Session on that repository publishes them on its own name,
without anyone asking: at every boot and wake, when the repository is added to the Session (`new --repo`, or
`runpane --host <Session> repos add --path <dir>`), and within a minute of a change to the file. It sits beside
[`.runpane/secrets.json`](#secrets-from-doppler-with-no-laptop-in-the-path-runpanesecretsjson) and holds no
secrets, so it's safe to commit.

```json
{
  "version": 1,
  "ports": [
    { "name": "web", "port": 5173 },
    { "name": "api", "port": 3000, "https_port": 3443 },
    { "name": "review", "port": 8787, "path": "/s/demo" }
  ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1` |
| `ports[].name` | yes | Lowercase letters, digits and hyphens, at most 40 characters; unique in the file |
| `ports[].port` | yes | The local port the service listens on in the Session; unique in the file |
| `ports[].https_port` | no | The tailnet port of the URL. Defaults to `port`; never `443` |
| `ports[].path` | no | The path shown in the link (default `/`). Serve forwards it unchanged, so the service must answer it itself |

- **The schema is strict.** Any other key, a duplicate name or port, `https_port: 443`, more than 20 ports or a
  file over 64 KiB makes the whole file invalid. `port list` shows `Manifest ...: INVALID` with the reason, and
  ports it opened before stay as they were.
- **Where it's read:** at the root of the repository's checkout in the Session (the folder Pane lists for that
  repository, on whatever branch is checked out there), not from Pane worktrees.
- **Precedence:** a manifest never replaces a Serve entry it didn't make. It waits (`port list` shows `error`
  with the reason) and opens once that entry is gone, or when you run `runpane port open <port> --yes`.
- **Removing an entry** from the file closes its port at the next check (within a minute). `port close` on a
  manifest port keeps it closed until you run `port open` for it again.
- **Declare only services that run whenever the Session is up** (started by a systemd unit, a dev container
  or a setup script). A declared port whose service nobody started just answers 502 on every Session of the
  repository. Publish on-demand dev servers with `runpane port open` instead.

#### Suggested ports and auto-open

When a process started from a Pane panel (an agent's dev server, `npm run dev` in a terminal) listens on
`127.0.0.1` or `0.0.0.0`, the Session **suggests** it within a few seconds. `port list` shows it under
"Suggested", and Pane shows it as a dimmed chip with **Open on tailnet**. It isn't published by itself,
because an unknown dev server shouldn't appear on your tailnet unasked. Processes outside Pane panels
(systemd units, cron jobs) are never suggested; publish them with `port open` or the manifest.

To publish every detected port automatically, turn on auto-open for that Session (it's kept in the Session's
`~/.runpane-cloud/ports.json`, so it survives sleep and wake):

```bash
runpane port auto-open on     # in the Session; `off` (the default) goes back to suggestions
```

**The trade-off.** With auto-open on, anything an agent starts listening on is reachable from every device your
tailnet policy lets in, within seconds, including services with no login (debug servers, database consoles,
a Node inspector on 9229). With it off, you choose each port, at the cost of one click or command per service.
Turn it on only for Sessions whose agents you trust to run nothing you wouldn't share with your tailnet, and
leave it off on Sessions that hold production credentials.

#### HTTPS certificates and the HTTP fallback

- **One certificate per Session name covers every port.** A Session created with `--transport https` (or
  `auto` that got HTTPS) already has its certificate, so its ports cost no new one.
- **A Session without one** (the weekly limit was hit when it was created, or `--transport http`) gets one on
  the first port you open, if Let's Encrypt allows it. Let's Encrypt issues at most 50 certificates a week per
  tailnet domain (see [HTTPS certificates](#https-certificates-and---transport)).
- **If no certificate comes within about 45 s,** the port is served as **plain HTTP inside the tailnet**
  (`http://<host>:<port>/`; WireGuard still encrypts it end to end). `open` and `port list` say so.
  - After one failed check, further ports on that Session go straight to HTTP for 10 minutes.
  - The daemon moves HTTP ports to HTTPS by itself once tailscaled holds a certificate for the name, and the
    link's scheme changes then.
  - `runpane port open <port> --scheme https` asks again right away. Let's Encrypt's refusal names the time it
    lifts: `429 ... retry after <UTC time>`.
  - `--scheme http` publishes plain HTTP on purpose.
- **What breaks over plain HTTP:** browsers treat an `http://` page on a non-localhost name as insecure. They
  refuse `Secure` cookies (so sign-ins that set one fail, Safari first), and they disable service workers and
  some APIs (clipboard, camera). If the service needs those, wait for HTTPS or use the forwarder fallback below.

#### Fallback: a local forwarder

Use this only when the HTTPS link can't work: the Session's name has no certificate yet and the app needs a
secure context, or the app insists on being opened as `http://localhost:<port>` (origins or cookies pinned to
localhost). It needs a program running on every machine that opens the app.

1. In the Session, publish the port as plain TCP instead of HTTPS. Close any `runpane port` entry on that
   port first: both use the same tailnet port.

   ```bash
   runpane port close <port>
   sudo tailscale serve --bg --tcp=<port> tcp://127.0.0.1:<port>
   ```

2. On your machine, forward `localhost:<port>` to it. Node is already there for `runpane`; Ctrl-C stops it:

   ```bash
   node -e "const n=require('net');n.createServer(c=>{const s=n.connect(<port>,'<host>.<tailnet>.ts.net');c.pipe(s).pipe(c);s.on('error',()=>c.destroy());c.on('error',()=>s.destroy())}).listen(<port>,'127.0.0.1')"
   ```

3. Open `http://localhost:<port>/` in Chrome or Edge (Safari refuses `Secure` cookies on `http://localhost`).

Undo it with `sudo tailscale serve --tcp=<port> off` in the Session, then `runpane port open <port>` to get
the HTTPS link back.

## 5. Sleep and wake

```bash
runpane cloud stop "api work" --yes   # flushes the disk, then stops: compute billing stops, disk kept
runpane cloud wake "api work"         # resumes and returns once the daemon answers /health
```

- A stopped Session keeps its disk (repositories, worktrees, Pane's database, agent transcripts), its
  tailnet name and its pairing. Wake takes about 15 to 25 seconds to `/health` (measured on `large`: 13 to
  23 s after boat reports it running).
- After a wake, panels come back: submitting to a panel restarts it if needed, and a Claude panel resumes
  the same conversation.
- boat's stop is a hard power-off after a live snapshot, with no shutdown signal. So `stop` first asks
  the daemon to flush (it checkpoints Pane's database and syncs the disk; an older daemon just gets
  `sync`). If an agent is still working or a terminal is busy, `stop` warns but stops anyway, because you
  asked. `--force` skips the flush; avoid it.
- `~/.cache`, `/tmp` and `/var/tmp` are not kept across a stop.
- Every wake counts against boat's start limit; see [Costs](#costs).
- `wake --size large` resumes onto a bigger machine (about 11 s); the disk is kept.

While a Session is asleep, Pane desktop can't connect to it. Wake it from the CLI, then pick it again in
the switcher. `runpane --host <asleep Session> ...` fails without waking it: a plain connection error, or
`ERR_RUNPANE_HOST_ASLEEP` when a coordinator is set up. With a coordinator, `panels submit` is the one
command that wakes the Session first (next section).

## 6. The coordinator (idle-stop and wake-on-submit)

The coordinator is a small always-on service on its own boat `small` sandbox in your tailnet. It:

- stops cloud Sessions that are idle: it asks each daemon's safe-to-stop, which refuses while an agent is
  working, a terminal printed output recently, a lock is held, a watcher is active, a PR has pending
  checks, or a desktop or phone client is attached (pending PR checks need a signed-in `gh` in the
  Session; without one that check can't see anything and doesn't block);
- stops (never destroys) managed sandboxes that are not in your directory, and alerts;
- answers `/cloud/wake`, so `runpane --host <asleep Session> panels submit` and peer Sessions can wake a
  sleeping Session;
- holds a scoped boat key (read, stop, resume; creating and deleting stay on your laptop) and, for each
  Session, a coordinator-scoped Pane token that can only ask safe-to-stop and run the pinned upgrade. It
  can't reach panels, shells or the event stream.

<!-- coordinator-deploy:start -->
Deploy it once from the laptop (one boat start; about 20 s):

```bash
runpane cloud coordinator deploy --yes
```

It creates a `small` sandbox named `<name-prefix>-coord` from your golden image, joins it to the tailnet
as `tag:rp-session` (Tailscale SSH off; over the tailnet it accepts only its API port, 47300), mints a
boat key scoped to `sandbox.read`, `sandbox.stop` and `sandbox.resume` (it can't outlive your account
key, so the CLI picks the longest lifetime boat accepts and prints it), installs the service from this
CLI's own package, and writes `~/.config/runpane-cloud/coordinator.json` (your caller token, 0600). From
then on:

- every `runpane cloud new` adds the coordinator's scoped client to the Session and writes the Session's
  peers list (`~/.config/runpane-cloud/peers.json` in the sandbox) naming the coordinator;
- `new`, `destroy` and `sync` push the directory, and `runpane cloud wake` wakes through the coordinator
  (so the pinned version and the idle-stop grace after a wake apply);
- Sessions created before the deploy have no coordinator client, so idle-stop skips them (deploy lists
  them).

It manages sandboxes named `<name-prefix>-*` and nothing else. Its reconciler stops (never deletes)
running sandboxes with that prefix that are not in your directory after 30 minutes, so give your cloud
Sessions a prefix no other tooling uses (`runpane cloud setup --name-prefix ...`).

```bash
runpane cloud coordinator status                # the coordinator itself: sandbox, service, version
runpane cloud coordinator stop --yes            # pause idle-stop and wake-on-submit (billing stops)
runpane cloud coordinator start                 # bring it back (one boat start)
runpane cloud coordinator deploy --yes          # run again to update it in place; no new sandbox
runpane cloud coordinator destroy --yes         # device, sandbox and scoped key; Sessions untouched

runpane cloud coordinator status "api work"     # its view of one Session, without waking it
runpane cloud coordinator wake "api work"
runpane cloud coordinator idle-check --dry-run  # what idle-stop would stop now
runpane cloud coordinator reconcile --dry-run
runpane cloud coordinator alerts
```

Deploy options: `--idle-check-seconds <n>` (default 300; a Session is stopped after two safe answers in a
row) and `--wake-grace-seconds <n>` (default 600) are kept across redeploys; `--no-reconcile` turns the
reconciler off; `--pin-version <v> --pin-deb-url <url> --pin-deb-sha256 <hex>` pins the Pane version, and
every Session the coordinator wakes is upgraded to it before it counts as awake (`--no-pin` removes the
pin). While the coordinator is stopped, idle Sessions just stay awake and only `runpane cloud wake` wakes
a sleeping one.

Only a deploy that creates the coordinator sandbox mints its scoped key; a redeploy updates the running
coordinator in place and mints none. `destroy` revokes the key through boat's API after deleting the
sandbox. If that call fails, `destroy` still finishes, names the key id it could not revoke, and you revoke
it under API Keys in boat's dashboard (it also expires on its own). A deploy that fails partway revokes
the key it minted the same way.
<!-- coordinator-deploy:end -->

## 7. Let one Session message another (peers)

By default a cloud Session can't reach any other. You can let Session A send messages to Session B's
orchestrator panel, and nothing else: no shells, no terminal output, no event stream. The receiving agent
sees `[peer message from <A's label>] <text>`, at most 10 messages a minute. A trusted peer can still steer
B's orchestrator agent, so allow only Sessions you would let type into it.

<!-- peers:start -->
From the laptop, with both Sessions set up by `runpane cloud new`:

```bash
runpane cloud peers allow <A> <B>      # A may message B's orchestrator; B must be awake
runpane cloud peers list
runpane cloud peers revoke <A> <B>     # B deletes the record: the token stops working at once
```

`allow` mints a peer record on B, allowlisted to one Pane Session on B: the only one you created, or
`--session <name>` when B has several (B needs one; create it in Pane desktop or with
`runpane --host <B> sessions create --from-json <file>`; the payload is in [SESSIONS.md](SESSIONS.md)). The token goes only into A's peers list in A's sandbox (0600); it is
never printed. The grant is one-way; run `allow B A` too for replies. If A is asleep, the grant is saved
and A's list is written when you next `runpane cloud wake A`.

An agent in Session A then uses B by its host name:

```bash
runpane --host <B> panels list
runpane --host <B> panels submit --panel orchestrator --text "..." --yes
```

With a coordinator, that submit wakes B if it is asleep and delivers once; `panels list` and `watch`
never wake it.
<!-- peers:end -->

## 8. GitHub access (private repositories and pushing)

A cloud Session never gets your own GitHub credential (your `gh` login or token reaches every repository
you can). Instead it gets access to **one repository at a time**. Its work is published either by the
coordinator's GitHub broker (below; no laptop needed once set up) or by your laptop (`cloud git push`).

### Publish through the coordinator (GitHub broker)

When the coordinator holds a GitHub App or fine-grained token (`runpane cloud coordinator github set`, see
[RUNPANE_CLOUD_COORDINATOR.md](RUNPANE_CLOUD_COORDINATOR.md)), a Session pushes branches and opens pull
requests and issues **itself**, through the coordinator. Your laptop can be closed. The Session never holds
a credential that can write to GitHub; the coordinator only writes inside that Session's own branch
namespace.

Give a Session a repository (setup, once, from the laptop):

```bash
runpane cloud new --repo https://github.com/<owner>/<repo> --github --yes    # a new Session
runpane cloud github connect "api work" --repo <owner>/<repo> --broker        # an existing, awake one
```

Both add the repository to the Session's entry in the coordinator's directory (`github.repos`, its
per-Session allowlist) and install, in the Session:

- **`~/.local/bin/gh`**, a `gh` look-alike: `gh pr create|view|list|comment|close|edit|checks|diff`,
  `gh issue create|view|list|comment|close` and `gh auth status`, mapped onto the broker. `--json` prints gh's
  field names and values (`state` OPEN/CLOSED/MERGED, `isDraft`, `headRefOid`, `mergeable`,
  `statusCheckRollup`), and `gh pr list --head <branch>` finds the PR of `cloud/<host>/<branch>` as well as of
  `<branch>` itself. So Pane's own `gh` calls inside the Session work too: the PR badge, the Session PR
  monitor, archive's merged-PR check and the dashboard. `gh pr diff` is rebuilt from the PR's files;
  `gh pr checks` needs the App's Checks and Commit statuses **read** permissions (without them it reports no
  checks). Every other gh command (`gh api`, including `gh api graphql`, `gh pr merge`, reviews, releases, ...)
  exits 2 with "not available in a runpane cloud Session (broker allowlist)". `~/.local/bin` is put first on
  `PATH` (at the top of `~/.bashrc`), ahead of any real `gh`, and `/usr/local/bin/gh` links to the shim
  unless that name is taken, because Pane's daemon finds `gh` through the system PATH.
- **`runpane cloud agent github ...`**, the same through runpane (all take `--json`):

  ```bash
  runpane cloud agent github push [--branch <b>] [--force]           # -> cloud/<host>/<b>
  runpane cloud agent github pr create --title T --body-file notes.md  # pushes, then a DRAFT PR
  runpane cloud agent github pr edit|close|comment <n> ...
  runpane cloud agent github issue create|comment|close ...
  runpane cloud agent github read pulls/12/files                     # read-only GitHub REST
  runpane cloud agent github status
  ```

- A short section in the agents' global instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`): how to
  push and open PRs and issues, that PRs are drafts, and that `master`/`main` is off-limits.

What happens on a push: the Session bundles the branch against `origin/<default branch>` (the whole branch
when they share no history) and uploads it; the coordinator pushes it to **`cloud/<host>/<branch>`**. It
refuses the default branch, tags, deletes, other Sessions' namespaces and any change under
`.github/workflows/`. Pull requests always open as **drafts** and carry a footer naming the Session. A plain
`git push` to GitHub still fails in the Session: there is no write credential there.

The Session calls the coordinator with its own caller token from its peers list
(`~/.config/runpane-cloud/peers.json`, written by `new`); nothing new is copied in. The coordinator also
checks the call comes from that Session's tailnet node.

**Reading (clone and fetch)** depends on the coordinator's credential:

- **GitHub App:** git asks `~/.local/bin/git-credential-runpane` (configured for `https://github.com` only),
  which gets a **read-only, one-repository token that expires within an hour** from the coordinator. No
  deploy key: `new --github` clones over `https://github.com/<owner>/<repo>.git`.
- **Fine-grained token:** it can't make read-only tokens, so the Session reads over a read-only deploy key
  as below (`new --github` and `connect --broker` add one, with your laptop's `gh`, once).

If the coordinator has no broker (or it doesn't reach the repository, or you pass `--read-write`),
`new --github` falls back to the deploy key and `cloud git push` below, and says so.

```bash
runpane cloud github list                                        # shows "coordinator broker" rows
runpane cloud github disconnect "api work" --repo <owner>/<repo> --broker
```

`disconnect --broker` takes the repository off the Session's allowlist (the coordinator refuses it at once)
and removes the shim, helper and notes when none is left.

### Let a Session read a repository (deploy key, the default)

```bash
runpane cloud github connect "api work" --repo <owner>/<repo>
```

1. The Session generates an ed25519 key pair inside its sandbox. The private key never leaves it
   (`~/.ssh/rp_github_<owner>-<repo>`, 0600).
2. Your laptop registers the public key on the repository as a **read-only deploy key**, with your `gh`
   login (`gh auth status`) or `--token-file <file>`. Adding a deploy key needs admin on the repository.
   Your credential stays on the laptop.
3. The Session gets an ssh host alias with github.com's host keys pinned (fetched from GitHub's API over
   HTTPS; `StrictHostKeyChecking yes`), and `connect` checks it can read the repository with the key.

Inside the Session, clone and fetch over the alias it prints:

```bash
git clone git@github.com-<owner>-<repo>:<owner>/<repo>.git
```

A read-only key can't push: GitHub refuses `git push` from the Session. That is on purpose. Publish work
with `runpane cloud git push` (below).

For a new Session, `runpane cloud new --repo https://github.com/<owner>/<repo> --github --yes` does the
same before it clones, so private repositories work. `new` checks your credential can add a deploy key
before it creates a sandbox.

```bash
runpane cloud github list                                  # which Session can reach which repository
runpane cloud github disconnect "api work" [--repo <owner>/<repo>]
```

`disconnect` deletes the deploy key on GitHub (also while the Session sleeps) and removes the key files from
the Session. `runpane cloud destroy` deletes a Session's deploy keys first. The key is listed on GitHub
under the repository's Settings > Deploy keys as `runpane-cloud <host> (read-only)`.

`--read-write` registers a writable deploy key instead. Anything in the Session (any agent) could then push
to **any branch, including the default branch**, and deploy keys ignore most branch rules on free plans.
Prefer the read-only default.

### Publish a Session's branch (mediated push)

```bash
runpane cloud git push "api work" --path <repo dir> --branch <branch>
```

1. The Session bundles `<branch>` with `git bundle`, only the commits the repository doesn't have yet.
2. The laptop downloads the bundle through the sandbox provider's files API (in 4 MiB parts, checked with
   sha256).
3. The laptop pushes it with **your** credential to `cloud/<host>/<branch>` and prints a compare URL to
   open a pull request from.

- `--path` is the repository directory in the Session (`api` means `/home/user/api`).
- The repository comes from the directory's `origin` remote, or `--repo <owner>/<repo>`.
- `--prefix <prefix/>` changes `cloud/<host>/`. The target is always `<prefix><branch>`, and
  `git push` **refuses the repository's default branch, `main` and `master`**, whatever the prefix.
- A branch that diverged from what was pushed before is refused; `--force` overwrites it (only ever the
  branch under the prefix).
- The Session must be awake.

### Or: a fine-grained personal access token

If you'd rather give the Session a token (for example to push over HTTPS from inside it), make a
**fine-grained** token for just that repository:

1. Open https://github.com/settings/personal-access-tokens/new (GitHub > your avatar > Settings >
   Developer settings > Personal access tokens > Fine-grained tokens > **Generate new token**).
2. **Token name**: e.g. `runpane-cloud api work`. **Expiration**: as short as you like (e.g. 30 days).
3. **Resource owner**: the account or organization that owns the repository.
4. **Repository access**: **Only select repositories**, then pick the one repository.
5. **Permissions** > **Repository permissions** > **Contents**: **Read-only** (clone and fetch), or
   **Read and write** to push from the Session. Leave everything else at *No access* (Metadata: Read-only
   is added automatically).
6. **Generate token**, copy it into a file (`umask 077; pbpaste > ~/rp-token` on macOS), then:

```bash
runpane cloud github connect "api work" --repo <owner>/<repo> --pat-file ~/rp-token && rm ~/rp-token
```

The token is checked against the repository from the laptop, then copied into the Session as a 0600 file
(`~/.config/runpane-cloud-git/`) behind a git credential helper that answers only for
`https://github.com/<owner>/<repo>`. It never appears in remotes, command lines or logs. Classic tokens
(`ghp_...`) and `gh` login tokens are refused: they reach every repository. Organizations can require an
owner's approval for fine-grained tokens. `disconnect` shreds the file; **delete the token itself** on
GitHub (Settings > Developer settings > Fine-grained tokens), since GitHub gives no API for that.

## 9. Destroy

```bash
runpane cloud destroy "api work" --yes
```

This deletes the Session's GitHub deploy keys, then the tailnet device, then the sandbox and its disk, checks both are gone, then removes the
local record and the Pane desktop profile. It can't be undone: push any work first (`runpane cloud git push`).
Destroy costs no boat start.

## Costs

| Size | Machine | Awake | Asleep |
|---|---|---|---|
| `small` | 2 vCPU / 4 GB | $0.018/h | $0 compute, disk kept |
| `default` | 4 vCPU / 8 GB | $0.036/h | $0 compute, disk kept |
| `large` | 8 vCPU / 16 GB | $0.072/h | $0 compute, disk kept |

- Measured with three agents running TypeScript builds and browser tests: `large` handled it; `default` and
  `small` ran out of memory. `default` is fine for one agent. `small` is for the coordinator (about $13 a
  month always on).
- A large Session awake 8 hours a day costs about $0.58 a day.
- Runaway guard: `new` refuses when 25 of your cloud sandboxes are already live. Change it with
  `runpane cloud setup --max-live <n>`.

### Which boat wallet pays (organizations)

A boat account can belong to organizations, each with its own plan, balance and start limits. boat bills
a new sandbox to the wallet the request names, else to the account's **active wallet**. That is one
account-wide setting: anyone switching it in boat's dashboard or with `boat org switch` changes where
every unnamed create goes. So pin the wallet:

```bash
runpane cloud setup --boat-org personal         # or an organization's name or team_… id (boat org list)
runpane cloud new --boat-org acme --label "Team work" --yes      # one Session elsewhere
runpane cloud coordinator deploy --yes --boat-org personal
```

- `new` and `coordinator deploy` send the wallet as `org` on the create and as `X-Boat-Org`. Without
  `--boat-org` or a saved wallet, boat bills the active wallet; `new` then prints which one it was.
- **A sandbox's wallet is fixed when it is created.** Each host records it (`boatOrg` in
  `runpane cloud list --json` / `status --json`, and a WALLET column), and every later call for that host
  (stop, wake, repair, exec, files, destroy, secrets, github) is scoped to it. Hosts made by an older CLI
  learn it from boat on first use.
- The coordinator's config carries its own wallet (`provider.org`), and its directory names each
  Session's wallet, so its idle-stops and wakes target the right one. A coordinator deployed by an older
  CLI keeps working. Redeploy it (`coordinator deploy --yes`) to record its wallet.
- Start limits are per wallet. Creating and resuming an organization sandbox counted against that
  organization's starts and left the personal counter alone (checked live). boat's docs say personal
  sandboxes use personal limits. `GET /limits` (and anything built on it) reads the **active** wallet
  unless you name one with `X-Boat-Org` or `?org=`, so check the wallet you mean.

**boat start limits.** boat counts every sandbox start account-wide: `new` is one start, and every `wake`
(including a coordinator wake) is one start. `stop`, `destroy`, `list` and `status` are free. The limits
are **12 a minute, 60 an hour and 200 a day**. Past them boat answers HTTP 429 and `new`/`wake` exit 1
with boat's message; the CLI does not retry. Wait and run it again.

## HTTPS certificates and `--transport`

Tailscale Serve gets each Session's HTTPS certificate from Let's Encrypt, which issues at most **50
certificates per week for your tailnet's domain** (`<tailnet>.ts.net`). Every new Session host name needs one,
so creating and destroying many Sessions in a week (tests, CI) uses the quota up, and new Sessions then can't
get a certificate. The limit lifts on its own after a few days.

`runpane cloud new --transport` (also a `setup` default):

- `auto` (default): tries HTTPS. If it doesn't answer within about 45 s while the Session's Pane is healthy,
  the Session switches to **plain HTTP inside the tailnet**: Tailscale Serve forwards TCP port 42137 to the
  daemon, and the host's address becomes `http://<host>.<tailnet>.ts.net:42137`. WireGuard still encrypts
  everything end to end; there's just no TLS layer on top.
- `https`: HTTPS only; `new` fails if no certificate comes.
- `http`: plain HTTP inside the tailnet from the start (uses no certificate).

`runpane cloud status <host>` shows which one a Session uses. Pane desktop and `runpane --host` work with both.
**The phone app at https://runpane.com/app can't reach an `http://` Session**: a page loaded over HTTPS
may not call plain HTTP (mixed content). Use Pane desktop or the CLI for such a Session, or create it again
(`--transport https`) once certificates are available.

To avoid the limit: keep long-lived Sessions and let them sleep instead of destroying and recreating them, and
run tests that churn Sessions in a separate tailnet.

## Tailnet policy

`runpane cloud` can't edit your tailnet policy (its OAuth client only mints keys). Each Session therefore
guards itself: an nftables table `inet rp_tailnet` (`/etc/rp-tailnet-firewall.nft`, reloaded at boot by
`rp-tailnet-firewall.service`, so it survives sleep and wake) accepts only replies and tcp/443 on
`tailscale0`. Published [Session ports](#reach-a-service-in-your-session-ports) (and the daemon's own Serve
entries) are answered inside `tailscaled` before this firewall, so they work without a rule of their own. The sandbox provider runs its own services on the machine (a desktop stream on 8090, an agent
service on 8911, sshd), and without the firewall a compromised peer Session could reach them.

Tighten the policy too, so the tailnet enforces the same thing. With grants:

```json
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:rp-session"], "ip": ["tcp:443", "tcp:47300", "tcp:1024-65535"] },
  { "src": ["tag:rp-session"], "dst": ["tag:rp-session"], "ip": ["tcp:443", "tcp:47300"] }
]
```

`tcp:47300` is only for the coordinator (section 6). Drop it if you don't run one. `tcp:1024-65535` lets your
own devices open [Session ports](#reach-a-service-in-your-session-ports); narrow it to the ports you
publish if you prefer. Sessions don't get it, so one Session can't reach another's services. Only ports a
Session publishes answer (the Session firewall drops everything else), so the wide range exposes nothing
more. Keep your own rules for your other devices.

## Repair a Session in place

`runpane cloud repair <host>` brings an awake Session up to date without stopping it: it re-enrols a tailnet
node that came back logged out, installs the guards newer CLIs add at `new` (a boot-time restore of
`tailscaled.state`, and of the Tailscale Serve config recorded in `/etc/rp-cloud/serve.json`), re-applies a
Serve config that a sleep/wake lost, and checks `/health`. It is safe to run any time; it refuses a sleeping
Session (wake it first). Run it once on Sessions created with an older `runpane`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Unknown command: cloud` | You are running Pane's bundled `runpane` (inside a Pane terminal) or the npm release. Use a normal terminal, or `"$(npm prefix -g)/bin/runpane"`; check `runpane version` shows `-rc.` |
| `new` or `wake` fails with `429` / "60 sandbox starts per hour" | boat's start limit (see [Costs](#costs)). Wait, then rerun. Prefer stopping and waking over creating new Sessions |
| `new` fails at the create step with a boat error about the snapshot | The saved golden image was deleted (releases keep only the newest two). `runpane cloud setup --golden <newer snapshot>`, or `--no-golden` |
| `setup` says a Tailscale key is invalid (401) | Wrong client id or secret, or the OAuth client lacks `auth_keys` for `tag:rp-session` |
| `new` fails at `install-pane` with a dpkg error (`failed to remove my own update file /var/lib/dpkg/updates/...`) | Seen once when a `--pane-deb-url` install ran on a fresh golden fork. `new` has already removed the sandbox and device; run it again. A golden image that already carries the right Pane (`--pane-preinstalled`, the default with `--golden`) skips this step |
| `new` fails at `tailscale-join` or the /health wait | Check the tailnet policy has `tag:rp-session`. `new` has already cleaned up; rerun with `--keep-on-failure` to look inside |
| `new` failed and `runpane cloud list` shows nothing for it | Rarely, boat creates the sandbox but naming it fails, and the CLI loses track of it. Look in boat's console for a sandbox without an `rp-` name created at that time and delete it there |
| A host from `runpane cloud new` or `sync` doesn't show in the desktop switcher, or vanished after you changed a setting | A released desktop was running during the import and then wrote its old config back. Quit Pane desktop, run `runpane cloud sync`, reopen it (see [Pane desktop](#pane-desktop)) |
| The desktop says "Connection failed" for a cloud host | The Session is probably asleep. The host switcher says so for cloud hosts ("Cloud host asleep or unreachable", with a Copy wake command item); run `runpane cloud wake <host>`, then pick it again. If it is awake, check `tailscale status` on the laptop |
| The phone app can't connect | The phone must be on the same tailnet (Tailscale app signed in and connected) |
| After a wake the Session (or the coordinator) doesn't answer; `tailscale status` in the sandbox says "Logged out" | boat sometimes restores a stopped sandbox with an empty Tailscale state file. `runpane cloud wake <host>` (or `runpane cloud coordinator start`) detects it and re-enrols the node under the same name; the pairing keeps working |
| `status` says `daemon-down` | The sandbox runs but the Pane daemon doesn't answer. Wake it again (`stop --yes`, then `wake`), or open the sandbox in boat's console and run `systemctl --user status pane-remote-daemon` |
| `github connect` says your credential cannot add deploy keys | Deploy keys need admin on the repository. Use an admin's token (`--token-file`), or a fine-grained token (`--pat-file`) |
| `git clone git@github.com:<owner>/<repo>` in a Session asks for a password or says `Permission denied (publickey)` | Clone over the alias `connect` printed: `git@github.com-<owner>-<repo>:<owner>/<repo>.git`. Plain `github.com` has no key |
| `git push` inside a Session fails with `ERROR: The key you are authenticating with has been marked as read only` | Expected with the default read-only key. Run `runpane cloud git push <host> --path <dir> --branch <branch>` from the laptop |
| `gh ...` in a Session exits 2 with "not available in a runpane cloud Session (broker allowlist)" | On purpose: only the pr/issue verbs and `gh auth status` go through the broker. See `runpane cloud agent github --help` |
| `gh`/`runpane cloud agent github` says "No runpane cloud coordinator is configured here" | The Session's peers list names no coordinator. From the laptop: `runpane cloud github connect <host> --repo <owner>/<repo> --broker` (rewrites it) |
| `gh`/`runpane cloud agent github` fails with `repo-not-allowed` | The repository isn't in this Session's allowlist: `runpane cloud github connect <host> --repo <owner>/<repo> --broker` |
| `runpane cloud agent github push` says "has no commits that origin/<default> lacks" | Commit first; or `git fetch origin` if the default branch moved |
| `cloud git push` fails fetching commits (`not our ref` / `unadvertised object`) | The Session's `origin/*` refs name commits GitHub no longer has (a force-push or deleted branch upstream). Run `git fetch --prune origin` in the Session, then push again |
| `status` says `lost` | The sandbox is gone on boat's side. `runpane cloud destroy <host> --yes` removes the tailnet device and the local record |
| A tailnet host name got a `-1` suffix | A device with that name already existed. `destroy` deletes the device first; if you re-enrol a node by hand, delete the old device in the Tailscale admin console first |
| Files written just before a stop are missing | boat powers off without warning ~4 s after the stop call. Don't use `stop --force`; let `stop` flush |
| A tool cache or `/tmp` file is gone after wake | `~/.cache`, `/tmp` and `/var/tmp` are not kept across a stop. Keep what matters under `/home/user` |
| `runpane --host X ...` fails to connect, or says `ERR_RUNPANE_HOST_ASLEEP` | X is asleep. Only `panels submit` with a coordinator wakes a Session; otherwise run `runpane cloud wake X` |
| A coordinator command says `no coordinator client config at .../coordinator.json` | `~/.config/runpane-cloud/coordinator.json` is missing; see [section 6](#6-the-coordinator-idle-stop-and-wake-on-submit) |
| `new`, `destroy` or `sync` warns "Retry with: runpane cloud sync" | The coordinator was unreachable. The change itself succeeded; run `runpane cloud sync` when it is back |
| An agent panel doesn't see a secret you just set | The panel was open before `secrets set`; open a new panel. Check the name with `runpane cloud secrets list <host>`; a login shell other than bash or zsh does not read the loader |
| `secrets set` says "Refusing ...: it matches the deny-list pattern" | On purpose: that family of credentials never enters a Session. Use a narrower, non-production key under another name only if it really is not a production credential |
| `doppler ...` in a Session says "No runpane cloud coordinator is configured here" | The Session's peers list names no coordinator: `runpane cloud github connect <host> --repo <owner>/<repo> --broker` from the laptop |
| `doppler run` says "no Doppler secrets are delivered to this Session: ... has no .runpane/secrets.json" | Commit the manifest to the branch the Session started from, then `doppler refresh` in the Session |
| `doppler refresh` fails with `manifest-invalid` | The manifest is not `{"version": 1, "doppler": [{"project", "config", "names"}]}`; the message names the problem. The Session's copy is cleared until it is fixed |
| `doppler refresh` fails with `manifest-ref-writable` | The Session was created from a `cloud/<its host>/` branch, which it can push to itself. Recreate it from a reviewed branch (`new --ref <branch>`) |
| `doppler run -c prd` says "not delivered: the coordinator's secrets policy (default) refuses config prd" | The default policy. Change it with `runpane cloud coordinator doppler policy` (your call), then `doppler refresh` |
| `doppler secrets get NAME` says "Could not find requested secret" | NAME is not in the manifest's names, not in Doppler, or withheld by policy (`doppler status` lists withheld names and why) |
| `coordinator doppler set` says "doppler could not create a read-only service token" | Log in (`doppler login`) as someone who can manage that project's service tokens, or pass `--token-file` with a token you made |
| `port open` says `ERR_PORTS_CONFLICT` | Another Tailscale Serve entry already holds that tailnet port (the message names it, for example a hand-made `tailscale serve --tcp` forward). `--yes` replaces it, or pick another with `--https-port` |
| `port open` says `ERR_PORTS_RESERVED` | Tailnet port 443 and the daemon's port (42137) are Pane's own. Pick another with `--https-port` |
| `port open` says `ERR_PORTS_IN_USE` | That local port is already published (close it first), or another published port uses that tailnet port (pick another with `--https-port`) |
| `runpane port ...` says "Session ports are not available here" or `ERR_PORTS_UNAVAILABLE` | You ran it outside a Runpane Cloud Session (on your laptop, say). Use `runpane cloud port <open\|list\|close> <host> ...` from the laptop. In a Session it means Tailscale isn't running: `tailscale status` |
| `runpane cloud port` says the Session's "Pane daemon predates Session ports", or `runpane port` in a Session says `No Pane daemon command registered for channel "runpane:ports:list"` | The Session's Pane is older than the ports feature. Pin a newer Pane on the coordinator (`runpane cloud coordinator deploy --pin-version ...`, [section 6](#6-the-coordinator-idle-stop-and-wake-on-submit)) and wake the Session, or create a new Session. On your laptop that message only means its Pane is older: use `runpane cloud port ... <host>` there |
| A port's URL doesn't open from a device, but `runpane port list --verify` in the Session says it answers | Your tailnet policy doesn't let that device reach the port; see [Tailnet policy](#tailnet-policy). Also check Tailscale is connected on that device |
| A port's URL doesn't open from anywhere, and `runpane cloud port` says "is it asleep?" | The Session is asleep; opening a link doesn't wake it. `runpane cloud wake <host>`, and the ports come back with it |
| A port's URL answers 502 | Nothing listens on that local port in the Session (yet). Start the service; the link stays. Also check that it listens on `127.0.0.1` or `0.0.0.0`: Tailscale Serve connects to `127.0.0.1:<port>`, so a service bound only to `::1` (Node resolving `localhost` to IPv6) answers 502. Start it with `--host 127.0.0.1` |
| The page says "Blocked request. This host ("rp-...ts.net") is not allowed" (Vite) or "Invalid Host header" (webpack-dev-server) | Tailscale Serve passes the Session's name as the `Host`, and the dev server only accepts `localhost`. Allow the tailnet: Vite `server: { allowedHosts: ['.ts.net'] }`, webpack-dev-server `allowedHosts: ['.ts.net']`. For Next.js dev, add the name to `allowedDevOrigins` |
| The page loads, but its links, images or API calls go to `localhost` | The app builds absolute URLs from a configured origin. Set its public URL (base URL, origin or "site URL" setting) to the port's `https://<host>.<tailnet>.ts.net:<port>` link |
| `port list` shows a port as `http` | The Session's name had no TLS certificate when it was opened (Let's Encrypt's weekly limit). It moves to https by itself once the name has one; `runpane port open <port> --scheme https` retries now. Until then, sign-ins that use `Secure` cookies fail; see the [HTTP fallback](#https-certificates-and-the-http-fallback) |
| `port list` shows `Manifest ...: INVALID` | `.runpane/ports.json` breaks the strict schema; the message names the key or value. Ports it opened before stay as they were |
| A port declared in `.runpane/ports.json` isn't published | The file is read at the root of the repository's checkout in the Session, not from worktrees, on the branch checked out there. `port list` shows `error` with the reason when another Serve entry holds the tailnet port. A port you closed stays closed until `runpane port open <port>` |
| A Session idle-stopped while someone was using a port's link | Browser visits don't count as activity. Hold a lock in the Session while the link is in use: `runpane lock acquire --name review --ttl 2h` |

To check a daemon by hand: `curl https://rp-<id>.<your-tailnet>.ts.net/health` returns its version and
readiness (`readiness.state`: `starting`, `ready` or `degraded`).

## Where things live

| Path | What |
|---|---|
| `~/.config/runpane-cloud/credentials.json` | boat key, Tailscale OAuth client, Anthropic key (0600). Override the directory with `RUNPANE_CLOUD_DIR` |
| `~/.config/runpane-cloud/settings.json` | golden image, default size, name prefix, runaway guard, `secretsDenyList`, `boatOrg` (the wallet new sandboxes bill), `agentNotes.guardrails` (your rules for agents in every Session) |
| `~/.runpane-cloud/secrets.env`, `secrets.json` (in the sandbox) | agent secrets from `runpane cloud secrets` (0600); loaded by a block at the top of `~/.bashrc` and `~/.zshenv` |
| `~/.runpane-cloud/doppler/secrets.json` (in the sandbox) | the Doppler set the coordinator delivered for the repository's `.runpane/secrets.json` (0600, 0700 dir); read by the `doppler` stand-in (`~/.local/bin/doppler`) and refreshed by the user unit `runpane-cloud-secrets.service` at every boot and wake |
| `.runpane/secrets.json` (in your repository) | which Doppler configs and names Sessions on the repository get; names only, safe to commit |
| `~/.runpane-cloud/ports.json` (in the sandbox) | the Session's published ports (0600); the Pane daemon owns it and re-applies it to Tailscale Serve at every boot and wake |
| `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` (in the sandbox) | notes for agents in the Session, in marked blocks: `runpane-cloud-ports` and `runpane-cloud-guardrails` (written by the Pane daemon; the guardrails from `~/.runpane-cloud/agent-notes.json`), `runpane-cloud-github` and `runpane-cloud-secrets` (written by the CLI when those are set up) |
| `.runpane/ports.json` (in your repository) | the services Sessions on the repository publish automatically; see [ports](#reach-a-service-in-your-session-ports) |
| `~/.config/runpane-cloud/hosts/<host>.json`, `.pairing` | one saved cloud Session and its pairing code (0600) |
| `~/.config/runpane-cloud/coordinator.json` | the coordinator's address and your caller token (0600) |
| `~/.config/runpane-cloud/hosts/<host>.json` (`meta.github`) | the Session's GitHub connections: repository, deploy key id and fingerprint (no secrets) |
| `~/.config/runpane-cloud/hosts/<host>.json` (`meta.githubBroker`) | the repositories the coordinator's GitHub broker acts on for the Session (the directory's `github.repos`) |
| `~/.local/bin/gh`, `~/.local/bin/git-credential-runpane` (in the sandbox) | the gh shim and the git credential helper; both run `runpane cloud agent ...` and hold no credential |
| `~/.pane/config.json` | Pane desktop's saved remote hosts; `new`, `sync` and `destroy` update it. Override with `--desktop-dir` or `RUNPANE_CLOUD_DESKTOP_DIR` (`PANE_DIR` is ignored on purpose) |
