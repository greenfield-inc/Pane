# Self-Hosted Remote Daemon

This guide covers running Pane on your own workstation, Mac mini, Linux box, or VM and connecting to it from the local Pane desktop app or the Remote Pane browser app.

The intended flow is:

1. Run one setup command on the remote machine.
2. Copy the generated `pane-remote://...` connection code.
3. Paste it into desktop Pane under `Settings > Remote Pane`, or open `https://runpane.com/app/` and paste it there.

Pane saves the profile and attempts to connect immediately. Local desktop mode is unchanged until a remote profile is imported and activated.

## One-Command Setup

Recommended package-manager commands:

```bash
npx --yes runpane@latest install daemon --label "VM"
pnpm dlx runpane@latest install daemon --label "VM"
pipx run runpane install daemon --label "VM"
uvx runpane@latest install daemon --label "VM"
```

SSH tunnel mode:

```bash
npx --yes runpane@latest install daemon --label "VM" --prefer-tunnel ssh
```

Persistent installs are also supported:

```bash
npm i -g runpane
runpane install daemon --label "VM"

python -m pip install runpane
runpane install daemon --label "VM"
```

From a source checkout:

```bash
pnpm remote:setup -- --label "VM"
```

SSH tunnel mode:

```bash
pnpm remote:setup -- --label "VM" --prefer-tunnel ssh
```

For validation against a separate data directory:

```bash
PANE_DIR=/tmp/pane-remote-vm pnpm remote:setup -- --label "VM" --prefer-tunnel ssh --print-only
```

Packaged Pane builds can run the same setup path without opening a window:

```bash
pane --remote-setup --label "VM"
```

On displayless Linux hosts, prefer `runpane install daemon`; the npm and PyPI
wrappers pass Electron's required headless flags automatically. For a direct
packaged launch, pass them explicitly:

```bash
pane --ozone-platform=headless --disable-gpu --remote-setup --label "VM"
```

These must be command-line arguments: Electron picks its Ozone platform before
the app starts, so the environment variable `ELECTRON_OZONE_PLATFORM_HINT` no
longer works (removed in Electron 38, ignored from 39 on).

The wrappers are lightweight installers and configurators. They currently
download the packaged Pane runtime because the daemon is not distributed as a
separate binary. AppImage installs therefore require FUSE; on Debian-based
hosts, `--format deb` avoids the AppImage/FUSE requirement.

If Pane is already installed on the host, this is the most direct command:

```bash
pane --remote-setup --label "VM" --prefer-tunnel tailscale
```

The setup command:

- detects Linux, macOS, or Windows host behavior
- writes remote daemon config into one `PANE_DIR` (default `~/.pane_remote`)
- enables the loopback listener on `127.0.0.1:42137`
- creates a paired client record with a hashed token on the host
- emits the raw token only inside the one-time `pane-remote://...` import code
- attempts to install and start a user-level daemon service
- prints the manual daemon command if service setup is unavailable
- detects Tailscale Serve where possible and otherwise prints an SSH local-forward command

Useful options:

```bash
pnpm remote:setup -- --help
pnpm remote:setup -- --channel nightly
pnpm remote:setup -- --pane-dir "$HOME/.pane_remote"
pnpm remote:setup -- --prefer-tunnel ssh
pnpm remote:setup -- --no-install-service
pnpm remote:setup -- --no-tailscale-serve
```

## Import Locally

On your local desktop machine:

1. Open Pane.
2. Go to `Settings > Remote Pane`.
3. Paste the full `pane-remote://...` code into `Import Remote Connection`.
4. Click `Import & Connect`.

If the tunnel is not reachable yet, Pane still saves the profile and shows the connection error. Start the printed SSH/Tailscale tunnel and click `Connect` on the saved profile.

## Use the Mobile / Browser App

The same connection code works in the Remote Pane PWA:

```text
https://runpane.com/app/
```

Use the PWA for phone or tablet access to terminal-backed remote sessions:

1. Set up the remote host with Tailscale or a trusted HTTPS tunnel.
2. Copy the full `pane-remote://...` code printed by setup.
3. Open `https://runpane.com/app/` on the client device.
4. Paste the code and connect.

For iPhone or iPad, open the URL in Safari, tap Share, then tap `Add to Home Screen`.
For Android, open the URL in Chrome, open the browser menu, then tap `Add to Home screen` or `Install app`.

SSH tunnel mode is mainly useful from desktop clients. For mobile browser access, prefer Tailscale or Manual HTTPS so the phone can reach the daemon URL directly.

### Remote PWA Implementation Notes

The Remote Pane PWA is a browser runtime. It does not have `window.electronAPI`, so client-side PWA preferences must use browser-safe storage such as `localStorage` or explicit daemon adapter calls. Do not reuse desktop renderer preference stores that persist through Electron IPC unless the call path is guarded for browser mode.

## Security Model

- The daemon listener only supports loopback hosts: `127.0.0.1`, `::1`, or `localhost`.
- Direct public or LAN binding is intentionally rejected.
- Use SSH local forwarding, Tailscale Serve, or a trusted HTTPS reverse proxy that forwards to loopback.
- Treat the generated `pane-remote://...` code like a secret. It contains the bearer token needed by the local client.

Tailscale Serve example generated by setup:

```bash
tailscale serve --bg http://127.0.0.1:42137
```

SSH fallback generated by setup:

```bash
ssh -N -L 42137:127.0.0.1:42137 user@your-host
```

## Manual Advanced Flow

The old manual flow still works and is useful for debugging.

### 1. Choose the Host Data Directory

```bash
export PANE_DIR="$HOME/.pane_remote"
mkdir -p "$PANE_DIR"
```

Pane stores config and database files under that directory. The setup command, desktop app, and headless daemon must use the same `PANE_DIR`.

### 2. Configure the Remote Listener

Launch Pane on the host against that directory:

```bash
PANE_DIR="$HOME/.pane_remote" pnpm dev
```

In `Settings > Remote Pane`:

1. Enable `Enable remote daemon listener`.
2. Keep `Listen Host` on `127.0.0.1`.
3. Keep or change `Listen Port`, default `42137`.
4. Leave `Require pairing / saved bearer tokens` enabled.
5. Leave `Allow direct HTTP on loopback` enabled.
6. Save host settings.

### 3. Create a Paired Connection

From the same settings section on the host:

1. Enter a label such as `Office Mac mini`.
2. Enter the base URL the client will use after tunneling, for example `http://127.0.0.1:42137`.
3. Click `Create Paired Profile`.

Pane adds a host-side allowed client record, adds a matching local profile, and shows the generated bearer token once.

### 4. Start the Headless Daemon

```bash
PANE_DIR="$HOME/.pane_remote" pnpm daemon:headless
```

On success:

```text
[Pane daemon] Headless host ready on tcp:127.0.0.1:42137
```

### 5. Connect the Desktop Client

Use `Import Remote Connection` for a generated code, or use `Save Existing Remote Profile` with:

- label
- base URL
- bearer token

Then click `Connect` on the saved profile.

## Validation

Recommended checks after connecting:

1. Verify projects and sessions load in the client.
2. Open a terminal-backed session and confirm output streaming works.
3. Send terminal input and verify the remote runtime receives it.
4. Resize a terminal and confirm the remote terminal resizes.
5. Open a file and confirm read/write works.
6. Check git status and commit/diff flows.
7. Run an approve-mode command and confirm the permission dialog appears on the client.

## Working Disconnected

When you are about to lose the network (a flight, a train), move a pane's work from the remote host to local Pane, keep working, and hand it back later. Two RunPane commands do this; the note they leave on the branch is the continuity between the two agents. No transcript moves and nothing uncommitted moves without a commit.

Both commands are available in the npm wrapper (`runpane` or `npx --yes runpane@latest`); the Python wrapper does not dispatch them yet.

### 1. Hand off on the runtime that owns the pane

Run this where the pane lives. For a remote host, that means over SSH or in a Pane terminal on the host, against the host's daemon:

```bash
runpane panes list --json
runpane panes handoff --pane <pane-id> --to local --yes --json
```

What it does, in order:

1. Refuses a dirty worktree and lists the files. Add `--include-dirty` to commit everything (including untracked files) as `handoff: work in progress`.
2. Fetches the upstream and refuses a non-fast-forward, naming the remote head. Pull or rebase first; nothing is committed or pushed on refusal.
3. Pushes the branch.
4. Writes `HANDOFF.md` at the worktree root with the pane name, branch, head sha, agent, open PR url, timestamp, and the last 80 lines of the CLI panel output (`--limit` changes the count), then commits and pushes it.
5. Parks the pane: it stays in the sidebar marked **Handed off**, its agent panel is closed, and `panes list --json` reports `handedOffAt`. Pass `--archive` to archive it instead, with the usual archive safety semantics.
6. Prints the exact `runpane panes receive` command for the target.

`--to` is a label (`local` or `remote:<Remote Pane profile label>`). It is recorded in the note and shapes the printed command; it does not contact the other runtime. If the label matches none of this runtime's saved profiles, the result carries a warning but still succeeds.

Review before handing off from a shared repository: the note embeds terminal output that is ANSI-stripped but not scrubbed for secrets, and `--include-dirty` stages untracked files.

### 2. Switch runtimes and receive

On your desktop, switch to the target runtime in `Settings > Remote Pane` (choose `Local` to work offline), then run the printed command against that runtime:

```bash
runpane panes receive --repo <repo> --branch <branch> --agent <codex|claude|cursor> --yes --json
```

Receive fetches the branch, reads `HANDOFF.md` from the remote ref (and refuses if it is missing), then:

- creates a local tracking branch and a Pane-managed worktree named after the source pane, or
- reuses a registered worktree on that branch that has no pane, or
- if this runtime already has a parked pane on that branch, fast-forwards it and clears the handed-off state.

The agent starts with one instruction: read `HANDOFF.md`, confirm the branch and head sha in its first message, continue the work, delete `HANDOFF.md` before opening a pull request, and do not push until asked. The output ends with the pane id and the `HANDOFF.md` path. If the instruction could not be verified as submitted, the pane still exists and the result names the `runpane panels submit` command to send it.

### 3. Hand back

The round trip is the same two commands in the other direction: `panes handoff --to remote:<label>` on local Pane, then switch to the remote profile and `panes receive` there. Because the remote host still has the parked pane, receive resumes it instead of creating a second one. Archiving a parked pane later works exactly as before.

## Troubleshooting

Start with machine-readable environment diagnostics:

```bash
runpane doctor --json
```

The `remoteSetup` section reports stable diagnostic codes and recovery commands
for missing AppImage/FUSE support, Electron sandbox restrictions, and missing
user service management. `runpane install daemon` automatically supplies the
Linux headless launch environment. Pane never disables the Electron sandbox
automatically; use `--no-sandbox` only when the host requires it and you accept
the security tradeoff.

### Remote setup exits because X11 or `$DISPLAY` is missing

Use `runpane install daemon`, or add `--ozone-platform=headless --disable-gpu`
to a direct packaged launch. This failure occurs before Tailscale setup and does
not mean the daemon requires a graphical session. If you previously relied on
`ELECTRON_OZONE_PLATFORM_HINT=headless`, switch to the flags: Electron removed
that variable in 38 and ignores it from 39 on.

### The headless daemon starts but remote connect fails

Check:

- the daemon uses the same `PANE_DIR` that setup wrote
- the tunnel/proxy forwards to the same loopback port as the host config
- the client profile base URL matches the client-side tunnel endpoint
- the `pane-remote://...` code was not truncated

### I changed host settings but nothing happened

The headless daemon watches config and starts or stops the remote transport based on saved host config. If behavior looks stale, restart the daemon once and verify the correct `PANE_DIR`.

### Why can’t I bind to `0.0.0.0` or a LAN IP?

That is intentionally blocked. The current security model is loopback plus a secure exposure layer.

### Why are some actions disabled in remote mode?

Some actions operate on the local desktop client machine rather than the remote workspace. Pane currently disables or keeps local-only behavior for:

- opening a local IDE from the client
- revealing files in the client OS file manager
- the native clipboard-image fallback path

## Current Limitations

- No hosted relay, NAT traversal, or account-based multi-tenant auth
- No direct non-loopback listener support
- No full live remote end-to-end CI harness yet
# Mobile push notifications

The native companion may register an APNs/FCM token through its existing paired bearer token. Registrations are scoped to that paired client and revalidated before every send. The daemon sends generic attention alerts for `blocked` and settled `working → idle` transitions; controls can disable either category per device. See [Native mobile](NATIVE_MOBILE.md) for the operator-only credentials and signing setup.
