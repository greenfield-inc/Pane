# Self-Hosted Remote Daemon

This guide covers running Pane on your own workstation, Mac mini, Linux box, or VM and connecting to it from the local Pane desktop app or the Remote Pane browser app.

The intended flow is:

1. Run one setup command on the remote machine.
2. Copy the generated `pane-remote://...` connection code.
3. Paste it into desktop Pane under `Settings > Remote Access`, or open `https://runpane.com/app/` and paste it there.

Pane saves the profile and attempts to connect immediately. Local desktop mode is unchanged until a remote profile is imported and activated.

## Workspaces or pairing codes?

To let your own machines reach each other from the runpane CLI, you do not need this guide or a code. [Workspaces](RUNPANE_WORKSPACES.md) put each desktop Pane on your tailnet automatically (port 8443) and trust your Tailscale login, so `runpane workspace <machine> read|write|exec|<command>` works between your Macs, Windows PCs, and Linux machines, and the desktop app's remote mode connects to them from Settings → Remote Access → Your machines. Use the remote daemon and pairing codes in this guide for browsers and phones, and for devices signed in to someone else's Tailscale account. The remote daemon keeps port 443, and the two run side by side.

## Guided quick start

On the host machine, run `npx --yes runpane@latest` in an interactive terminal.
Choose **Set up a remote host**, enter a name (or press Enter),
and follow the Tailscale installation/login prompts. The wizard picks an available
port and prints a connection code. Sign your other device into the same Tailscale
network, then paste the code into Pane or [runpane.com/app](https://runpane.com/app/).

If the host later switches to another tailnet, Pane notices while it runs: within
a minute it re-creates the `:443` Serve forward on the new tailnet, and new codes
use the new address. Codes created before the switch still point at the old
tailnet, so create a new one. If Pane cannot confirm the forward, it shows the
error and the `tailscale serve` command to run instead of creating a code.

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

Pane does not create or manage cloud machines. Create the VM yourself, then set
it up as a Remote Pane host:

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

## Import Locally

On your local desktop machine:

1. Open Pane.
2. Go to `Settings > Remote Access` and click `Add with a Code` under `Your computers`.
3. Paste the full `pane-remote://...` code into `Connection Code`.
4. Click `Connect`.

If the tunnel is not reachable yet, Pane still saves the host and shows the connection error. Start the printed SSH/Tailscale tunnel and click `Connect` next to the saved host.

## Use the Mobile / Browser App

The same connection code works in the Remote Pane PWA:

```text
https://runpane.com/app/
```

Use the PWA for phone or tablet access to remote terminals, browser tabs and files:

1. Set up the remote host with Tailscale or a trusted HTTPS tunnel.
2. Copy the full `pane-remote://...` code printed by setup.
3. Open `https://runpane.com/app/` on the client device.
4. Paste the code and connect.

For iPhone or iPad, open the URL in Safari, tap Share, then tap `Add to Home Screen`.
For Android, open the URL in Chrome, open the browser menu, then tap `Add to Home screen` or `Install app`.

SSH tunnel mode is mainly useful from desktop clients. For mobile browser access, prefer Tailscale or Manual HTTPS so the phone can reach the daemon URL directly.

### Browser tabs on the phone

Add Tool → Browser opens a browser tab on the phone. A new tab lists the host's listening ports, and the Ports button in the address bar opens the same list. Tap a `web` port to open it; `tcp` ports read "desktop only". The address bar is editable and reads the host's own address, such as `localhost:5173/ on <host>`. Copy URL copies the address the phone actually loads, and Open in Safari opens it outside the app. Use Open in Safari for sites that refuse to load in a frame, such as github.com: the tab cannot tell when that happens.

How a host page reaches the phone:

- When a phone first opens a `web` port, Pane gives that port its own HTTPS address on the host's tailnet name, `https://<host>.ts.net:<n>`, with a `tailscale serve` handler; the tab shows the page under a second later. Pane picks `n` from 44300 up, so it never takes the dev server's own port number. Handlers exist only for opened ports because Tailscale drops its whole Serve config, other apps' handlers included, once a machine holds a few hundred.
- Each handler points at a loopback preview proxy that checks the visitor's Tailscale login, sends the request to `localhost:<port>` as the dev server expects, carries live-reload WebSockets, and drops the headers that stop a page from loading in a frame.
- HTML files opened in a browser tab (for example by `runpane panels open --url file://...`) load from one more Serve address, with the files beside them. Files outside the page's folder are refused.
- A handler goes when its port stops listening, when Pane quits, and at the next launch after a crash. Quit spends at most 5 seconds removing them; a launch removes any it left. Pane changes only handlers it created: their targets start with `/pane-<hash of the Pane data directory>/`, so a dev build and the installed app never remove each other's.

Who can open these pages: the devices that **Who can connect to this machine** admits (see [Who is trusted](RUNPANE_WORKSPACES.md#who-is-trusted)). Phone pages need that setting on, Tailscale running on the host, and the phone on the same tailnet. A page in a frame cannot send the machine's password, so phone pages are off while password protection is on. A refused device sees "This page runs on &lt;host&gt;. Open it from a device signed in as &lt;login&gt;." A pairing code or SSH tunnel does not grant access to these pages: they need the phone on this tailnet, signed in with a login that setting admits. Navigation inside a page stays on the phone; the tab saves only the addresses you enter or pick.

### Files on the phone

Each pane's Explorer tab shows its worktree as a tree. Tap a text file to read and edit it; Save writes it to the host. Text files over 1 MB, and binary files that are not images, PDFs, video or audio, stay on the desktop. Images, PDFs, video and audio of any size preview on the phone, and video seeks without downloading the whole file. Open in Safari opens a preview outside the app.

Browsing and editing go through the PWA's own connection, so they work over every connection the PWA supports. Previews load from the same Serve address as HTML files in browser tabs, so they need what [browser tabs on the phone](#browser-tabs-on-the-phone) need: Tailscale on the host, password protection off, and a phone signed in to a login that **Who can connect to this machine** admits. Without that, a preview explains why it cannot load. Files outside the worktree are refused.

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

### Where does copied terminal text go?

To the clipboard of the machine you are sitting at. In remote mode, dragging to select text in a terminal copies it right away, with no Copy popover. Programs that copy with OSC 52, such as Claude Code, tmux, and vim, also copy to your machine. Programs in the terminal cannot read your clipboard through OSC 52.

## Current Limitations

- No hosted relay, NAT traversal, or account-based multi-tenant auth
- No direct non-loopback listener support
- No full live remote end-to-end CI harness yet
# Mobile push notifications

The native companion may register an APNs/FCM token through its existing paired bearer token. Registrations are scoped to that paired client and revalidated before every send. The daemon sends attention alerts for `blocked` transitions and for settled `working → idle` transitions of turns a person started; controls can disable either category per device. See [Native mobile](NATIVE_MOBILE.md) for the operator-only credentials and signing setup.
