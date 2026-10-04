# Self-Hosted Remote Daemon

This guide covers running Pane on your own workstation, Mac mini, Linux box, or VM and connecting to it from the local Pane desktop app or the Remote Pane browser app.

The intended flow is:

1. Run one setup command on the remote machine.
2. Copy the generated `pane-remote://...` connection code.
3. Paste it into desktop Pane under `Settings > Remote Access`, or open `https://runpane.com/app/` and paste it there.

Pane saves the profile and attempts to connect immediately. Local desktop mode is unchanged until a remote profile is imported and activated.

## Guided quick start

On the host machine, run `npx --yes runpane@latest` in an interactive terminal.
Choose **Set up a remote host**, enter a name (or press Enter),
and follow the Tailscale installation/login prompts. The wizard picks an available
port and prints a connection code. Sign your other device into the same Tailscale
network, then paste the code into Pane or [runpane.com/app](https://runpane.com/app/).

SSH and manual URL setups remain available through the explicit commands below.
The no-argument and `setup` commands print help in non-interactive shells; they
do not start a login prompt.

## Creating a code in desktop Settings

Desktop setup uses an installed, signed-in Tailscale client. If Tailscale is
missing, Pane shows installation instructions; use the setup terminal to install
it. Tailscale discovery, Serve configuration and requested daemon service setup
run asynchronously so the desktop stays responsive while they finish.

## One-Command Setup

To skip the wizard menu, run interactive remote setup directly:

```bash
npx --yes runpane@latest install daemon --interactive-tailscale-setup --auto-listen-port --label "VM"
pnpm dlx runpane@latest install daemon --interactive-tailscale-setup --auto-listen-port --label "VM"
pipx run runpane install daemon --interactive-tailscale-setup --auto-listen-port --label "VM"
uvx runpane@latest install daemon --interactive-tailscale-setup --auto-listen-port --label "VM"
```

SSH tunnel mode:

```bash
npx --yes runpane@latest install daemon --label "VM" --prefer-tunnel ssh
```

Persistent installs are also supported:

```bash
npm i -g runpane
runpane install daemon --interactive-tailscale-setup --auto-listen-port --label "VM"

python -m pip install runpane
runpane install daemon --interactive-tailscale-setup --auto-listen-port --label "VM"
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
- attempts to install and start a user-level daemon service (on Linux, it also
  enables lingering so the service keeps running after you log out)
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

## Run Pane on a Cloud VM

To bring your own VM, create it yourself, then set it up as a Remote Pane host.
For a sandbox that Pane creates and manages, see
[Cloud sandbox (experimental)](#cloud-sandbox-experimental).

1. Create an Ubuntu 24.04 VM with any provider. Size it for the agents and
   builds you plan to run. It only needs inbound SSH. The daemon listens on
   loopback, and you reach it through Tailscale or an SSH tunnel.
2. SSH in as a regular user with `sudo`, not as `root`.
3. Install what your agents need on the VM: `git`, Node.js 20 or newer (for
   `npx`), and the agent CLIs you use, such as Claude Code or Codex. Sign in
   to each CLI on the VM. Agents run there, not on your laptop.
4. Install Tailscale and join your tailnet:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

5. Install Pane and create a connection code. `--format deb` installs the
   Debian package, so the host does not need FUSE:

   ```bash
   npx --yes runpane@latest install daemon --label "Cloud VM" --format deb
   ```

6. Check that the daemon keeps running after you log out. It runs as a systemd
   user service, and setup turns on lingering (through passwordless `sudo` if
   needed) so the service outlives your SSH session. If the setup output says
   it could not, enable lingering yourself:

   ```bash
   sudo loginctl enable-linger "$USER"
   systemctl --user status pane-remote-daemon.service
   ```

7. Paste the printed `pane-remote://...` code into desktop Pane (see
   [Import Locally](#import-locally)) or into `https://runpane.com/app/`.

To start, stop, or delete the VM, use your provider's console or CLI. If
something fails, run `npx --yes runpane@latest doctor --json` on the VM and
check [Troubleshooting](#troubleshooting).

### Restarts and stopped VMs

Panes, panels, worktrees and agent transcripts survive a daemon restart, a
reboot and a VM stop. Running processes do not:

- The headless daemon saves terminal scrollback and flushes its database every
  10 seconds, because many providers stop a VM with a power-off and no
  shutdown. Output from the last few seconds before a power-off can be lost.
- An agent panel that was running comes back with its conversation (`claude
  --resume`, `codex resume`, `cursor-agent --resume`) when you open it.
- A plain shell starts fresh in its worktree when you open it.

To bring agents back as soon as the daemon starts, without opening each Pane,
set `PANE_RESUME_AGENTS_ON_START=1` for the service:

```bash
mkdir -p ~/.config/systemd/user/pane-remote-daemon.service.d
printf '[Service]\nEnvironment=PANE_RESUME_AGENTS_ON_START=1\n' \
  > ~/.config/systemd/user/pane-remote-daemon.service.d/resume-agents.conf
systemctl --user daemon-reload
```

Then every agent that was running when the VM stopped relaunches on the next
start, including after a daemon upgrade, and uses tokens and memory right away.
Before relaunching an agent, the daemon stops anything an earlier daemon process
left running for that panel, so a conversation never has two agents.

## Cloud sandbox (experimental)

A cloud sandbox is a [boat.dev](https://boat.dev) sandbox that Pane creates for you, already set up as a
Remote Pane host: Pane is installed, the sandbox has joined your tailnet, and it is paired and saved in your
remote hosts. Stop it when you are done (a stopped sandbox costs nothing) and start it again later: the tailnet
name, the Sessions and the agents' conversations come back.

> **A running sandbox bills until you stop it.** Nothing stops an idle sandbox automatically, even when no
> agent is working and no app is connected. **Settings > Remote Access** shows how long each sandbox has been
> running ("running for 5h"); stop the ones you are not using.

### What you need

- **A boat.dev API key**, on a plan that allows sandboxes without a time limit. If your account bills more
  than one wallet (organization), choose the wallet once; every new sandbox bills it.
- **A Tailscale OAuth client** whose client is allowed to create auth keys tagged `tag:rp-session` and to
  read and delete devices (scopes `auth_keys` and `devices:core`). Your tailnet policy must define the tag,
  for example `"tagOwners": { "tag:rp-session": ["autogroup:admin"] }`. Recommended grants, so your devices
  reach the sandboxes but sandboxes reach nothing else:

  ```json
  "grants": [
    { "src": ["autogroup:member"], "dst": ["tag:rp-session"], "ip": ["tcp:443", "tcp:42137"] }
  ]
  ```

- **Tailscale on every device that connects**, including the desktop.
- Optional: **a Claude token** (`claude setup-token`). Claude Code agents in every new sandbox sign in with it.

### Create one

In desktop Pane, open **Settings > Remote Access**, enter the keys once, then choose **Add cloud sandbox**.
The **Cloud sandboxes (experimental)** section there:

- shows each credential only as **Set** or **Not set**, plus the boat wallet's name. Saving checks the keys
  with boat.dev and Tailscale first. Leave a field blank to keep what is saved.
- takes a name (lowercase letters, digits and dashes) and a size, and lists each provisioning step while the
  sandbox is created. A failed create leaves nothing behind; **Retry** runs it again.
- lists each sandbox with its state (Running, Stopped, Creating, Error) and **Stop**, **Start** and **Remove**,
  which asks for confirmation first. A running sandbox shows how long it has been running.
- offers **Update Pane** when the sandbox's daemon reports a different Pane version than the desktop. It installs
  the desktop's own release `.deb`, checked against that release's `SHA256SUMS.txt`.
- has a **Startup script** editor: one script, kept on this computer, that every sandbox runs each time it starts.
  A failed run shows on the sandbox's row with **View log**. See
  [Cloud sandbox startup script](CLOUD_SANDBOX_STARTUP_SCRIPT.md).
- has a **Local start script** editor: a script that runs on this computer before each sandbox create and start, whose
  `NAME=value` output becomes variables on that sandbox only (for example a Doppler token). See
  [Local start script](CLOUD_SANDBOX_STARTUP_SCRIPT.md#local-start-script).

Stopping or removing the host the desktop is connected to switches the desktop back to **This computer**
first. In the host switcher, a stopped sandbox reads **Stopped · Select to start**: choosing it starts the
sandbox and then connects.

From a terminal, the same library is the `runpane cloud` command:

```bash
runpane cloud setup --boat-key-file - --boat-org <org|personal> \
  --tailscale-client-id <id> --tailscale-secret-file <path> --claude-token-file <path>
runpane cloud new --label "Cloud sandbox" --yes
runpane cloud list
runpane cloud stop <host> --yes
runpane cloud start <host>
runpane cloud remove <host> --yes
```

Secrets are read from files or stdin (`-`), never from arguments. They stay on this machine, in
`~/.config/runpane-cloud` (mode 0600; `$RUNPANE_CLOUD_DIR` overrides it), and are never printed. `new` adds the
host to desktop Pane's saved remote hosts in `~/.pane/config.json` (`$RUNPANE_CLOUD_DESKTOP_DIR` overrides it).
`runpane help cloud <command>` lists every option.

`new` takes about 1.5 minutes when the HTTPS certificate comes, and about 3.5 minutes when it falls back to
plain HTTP (below). It:

1. creates the sandbox in the chosen wallet;
2. resets its identity: a fresh machine-id and SSH host keys, and no credentials or Pane state left from the image.
   The OS takes the sandbox's tailnet name (`rp-…`), so `hostname` and shell prompts show it. A resumed sandbox comes
   back with boat's machine name, so Start, Update and a boot unit (`rp-hostname.service`) give the name back;
3. closes inbound tailnet traffic except Tailscale Serve (an nftables table, reloaded at every boot);
4. joins your tailnet with a single-use, pre-authorized auth key tagged `tag:rp-session`, with Tailscale SSH off;
5. prepares agents: Claude Code signs in with the saved token, its first-run, folder-trust and
   bypass-permissions prompts are answered ahead of time (`~/.claude.json`, plus `CLAUDE_CODE_SANDBOXED=1`
   in the daemon's environment so a repository added later is trusted too), and the daemon relaunches
   interrupted agent panels when the sandbox starts again (`PANE_RESUME_AGENTS_ON_START=1`);
6. installs Pane (the latest release, or the `.deb` given with `--pane-deb-url` and its required
   `--pane-deb-sha256`) and pairs it;
7. waits for the daemon at `https://<host>.<tailnet>.ts.net` through Tailscale Serve.

Every new tailnet name needs a Let's Encrypt certificate, and Let's Encrypt issues at most 50 a week for a
tailnet's domain. When the certificate doesn't come within about 50 seconds, the sandbox is served over plain
HTTP inside the tailnet instead, at `http://<host>.<tailnet>.ts.net:42137`. WireGuard still encrypts that
traffic, but the phone app at `runpane.com/app` can't use it. `--transport https` or `--transport http` picks
one explicitly.

If any step fails, `new` removes the sandbox and its tailnet device before it reports the error.

The sandbox tells Claude Code it is sandboxed (`CLAUDE_CODE_SANDBOXED=1`, set only for the sandbox's Pane daemon),
so Claude Code skips its folder-trust prompt there, also for repositories you add later. This computer and remote
hosts you set up yourself are not affected.

New Claude Code panels in a sandbox start with the same default model as Claude Code on this computer. An
explicit default wins: `ANTHROPIC_MODEL`, else `model` in `~/.claude/settings.json`. With neither, Pane detects the
model your Claude Code picks for itself (your account's default). It starts your `claude` once with its network
blocked (every proxy variable points at a closed local port), reads the model from the first line Claude prints, and
stops it. No message reaches Anthropic, nothing is saved, and Pane reads only that line. The result is cached until
`claude` or your settings file changes. Create, Start and Update apply the model again, and so does connecting to a
sandbox, so a change follows. While the desktop is connected to a sandbox, it also watches Claude's settings folder
(read-only): when `settings.json` changes and the default it now gives differs from the one a running sandbox last got,
the desktop sends the new one, so it reaches the sandbox's next new panel within seconds. If detection fails (no
`claude` on `PATH`, no answer within 15 s), Pane sends no model: the sandbox keeps the model it has (a new one uses
Claude Code's own default), and a notice saying why is logged. It is not a pin: a model picked inside
the sandbox with `/model` is kept.

Codex is installed in every sandbox but not signed in. Sign it in yourself: run `codex login --device-auth` in the
sandbox's terminal (**Terminal on <sandbox>**).
First enable device code authorization in your ChatGPT settings (Security), then run codex login --device-auth.
Claude Code signs in by itself when a Claude token is saved.

On cloud sandboxes, Pane stores the GitHub token in ~/.config/gh/hosts.yml (owner-only).

Detection is best effort. Known limits:

- When this computer's Claude Code is signed in only with a token (`CLAUDE_CODE_OAUTH_TOKEN`), it prints no
  model before it calls the API, so detection finds nothing: no model is sent, and the sandbox keeps its own
  default. Set `model` in `~/.claude/settings.json` to choose one; an explicit setting always wins.
- `ANTHROPIC_MODEL` is read from the desktop app's own environment. An app started from the dock or Start menu
  doesn't see variables exported in your shell profile; use `model` in `~/.claude/settings.json` instead.
- Signing Claude Code in to a different account doesn't refresh a detected default by itself. It refreshes when
  `claude` or `~/.claude/settings.json` changes, or when Pane restarts.

### Stop, start, update and remove

- **Stop** syncs the disk, then boat snapshots the sandbox and powers it off. Billing stops; the disk and the
  tailnet name are kept. Stop can take a few minutes when boat is slow to save the sandbox: Pane shows
  "Saving the sandbox…" and waits up to 15 minutes.
- **Start** resumes the sandbox and waits until the daemon answers. A resume has been seen to bring the
  Tailscale node back logged out, or without its Serve config. Start repairs either: it re-applies Serve, or
  re-enrolls the node under the same name, so the saved host keeps working.
- **Update** (`runpane cloud update <host> --pane-deb-url <url> --pane-deb-sha256 <hex> --yes`) installs another
  Pane `.deb` on a running sandbox and restarts its daemon. Pairing and Sessions are kept, and the agent
  preparation from step 5 is applied again.
- **Remove** deletes the sandbox and its disk, its tailnet device, the saved remote host and the local record.
  Only devices tagged `tag:rp-session` under the sandbox's name are deleted. Any other device with that name is
  left alone and reported.

### Signing in on a sandbox

Nobody sits at a sandbox's screen, so its saved host tells Pane two things:

- The sandbox's host terminal starts with `BROWSER=false` and `GH_BROWSER=false`. `gh auth login` and `codex login`
  print their sign-in URL and code instead of opening a browser on the sandbox.
- gh keeps a cloud sandbox's GitHub token in its hosts.yml (see above), not the keyring: the sandbox's keyring
  can't be unlocked without someone at its screen, so when Pane signs gh in on a sandbox it uses
  `gh auth login --insecure-storage`. Self-hosted remotes keep gh's default, the keyring.

## Import Locally

On your local desktop machine:

1. Open Pane.
2. Go to `Settings > Remote Access > Connections`.
3. Paste the full `pane-remote://...` code into `Connection code` under `Add connection`.
4. Click `Import & Connect`.

If the tunnel is not reachable yet, Pane still saves the profile and shows the connection error. Start the printed SSH/Tailscale tunnel and click `Connect` on the saved profile.

### Terminal on the host

To sign in to tools such as `gh` or `codex` before you open a repository, open the host switcher and click the terminal button on the connected host's row ("Open terminal on <host>"). It opens a plain shell on the host, in its home folder, as the tab `<host> · Terminal`. Each host has one such terminal: closing the tab keeps the shell running, and opening it again brings back the same shell. The host keeps it in a hidden session under `<pane dir>/sessions/host-terminal`, so it never shows up as a repository or a Pane.

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
tailscale serve --bg --tls-terminated-tcp=443 42137
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

In `Settings > Remote Access > Advanced Remote Host`:

1. Enable `Enable remote daemon listener`.
2. Keep `Listen Host` on `127.0.0.1`.
3. Keep or change `Listen Port`, default `42137`.
4. Leave `Require pairing / saved bearer tokens` enabled.
5. Leave `Allow direct HTTP on loopback` enabled.
6. Click `Apply Host Settings`.

### 3. Create a Paired Connection

From `Pairing tools` on the same page:

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
[Pane daemon] Headless host ready on unix:<socket path>
```

On Windows the endpoint is `pipe:<pipe name>`. This is the local control endpoint, not the remote listener port.

### 5. Connect the Desktop Client

Use `Add connection` for a generated code, or use `Save existing remote profile` under `Pairing tools` with:

- label
- base URL
- bearer token

Click `Save Remote Profile`, then click `Connect` on the saved profile.

## Validation

Recommended checks after connecting:

1. Verify projects and sessions load in the client.
2. Open a terminal-backed session and confirm output streaming works.
3. Send terminal input and verify the remote runtime receives it.
4. Resize a terminal and confirm the remote terminal resizes.
5. Open a file and confirm read/write works.
6. Check git status and commit/diff flows.
7. Run an approve-mode command and confirm the permission dialog appears on the client.

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

### A remote action could not be confirmed

The browser client automatically retries a reviewed set of read-only requests after
transient network or server failures. It sends actions such as terminal input and
pane creation once: the host may finish an action even if the response is lost.
If Pane says the action may have completed, inspect the current panes or terminal
before submitting it again. Authentication failures stop immediately.

The browser normally uses native EventSource for output. Its fetch fallback and
the desktop transport share one SSE text parser, accepting LF, CRLF, and CR line
endings across chunks. Each transport decodes UTF-8 incrementally before parsing;
reconnecting discards the previous stream's incomplete event. Terminal output
responses are applied only to the terminal instance that requested them, so a
late response cannot clear or write to a terminal disposed during a tab switch.

### I changed host settings but nothing happened

The headless daemon watches config and starts or stops the remote transport based on saved host config. If behavior looks stale, restart the daemon once and verify the correct `PANE_DIR`.

### Why can’t I bind to `0.0.0.0` or a LAN IP?

That is intentionally blocked. The current security model is loopback plus a secure exposure layer.

### Why are some actions disabled in remote mode?

Some actions operate on the local desktop client machine rather than the remote workspace. Pane currently disables or keeps local-only behavior for:

- opening a local IDE from the client
- revealing files in the client OS file manager
- the native clipboard-image fallback path

### Which machine do repo paths refer to?

The remote host. In remote mode, Open project, New project and Clone run on the host's daemon, so every path you pick or type is a path on that host. The daemon lists the host's folders through `fs:browse-directories` (it opens at the host's home folder) and checks typed paths there:

- On a Linux or macOS host, a Windows path such as `C:\Users\me\repo` is rejected with "That's a path on this computer; <host> is a Linux host. Pick a folder on <host>."
- Open project needs the root folder of an existing git repository on the host. It never creates a folder or runs `git init`; New project does both.
- Clone defaults to the host's home folder, and `~` in the destination means the host's home.

The dialogs show which host they act on with a chip at the top, for example "On: devbox (remote host)". On a remote host, Browse opens Pane's own folder browser instead of this computer's file dialog: it starts at the host's home, has Up and Show hidden folders, marks git repositories, and offers New folder when creating a project or picking a clone destination.

### Where does copied terminal text go?

To the clipboard of the machine you are sitting at. In remote mode, dragging to select text in a terminal copies it right away, with no Copy popover. Programs that copy with OSC 52, such as Claude Code, tmux, and vim, also copy to your machine. Programs in the terminal cannot read your clipboard through OSC 52.

## Current Limitations

- No hosted relay, NAT traversal, or account-based multi-tenant auth
- No direct non-loopback listener support
- No full live remote end-to-end CI harness yet
# Mobile push notifications

The native companion may register an APNs/FCM token through its existing paired bearer token. Registrations are scoped to that paired client and revalidated before every send. The daemon sends generic attention alerts for `blocked` and settled `working → idle` transitions; controls can disable either category per device. See [Native mobile](NATIVE_MOBILE.md) for the operator-only credentials and signing setup.
