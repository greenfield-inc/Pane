# Self-Hosted Remote Daemon

This guide covers running Pane on your own workstation, Mac mini, Linux box, or VM and connecting to it from the local Pane desktop app or the Remote Pane browser app.

The intended flow is:

1. Run one setup command on the remote machine.
2. Copy the generated `pane-remote://...` connection code.
3. Paste it into desktop Pane under `Settings > Remote Access`, or open `https://runpane.com/app/` and paste it there.

Pane saves the profile and attempts to connect immediately. Local desktop mode is unchanged until a remote profile is imported and activated.

## Workspaces or pairing codes?

To let machines on your tailnet reach each other from the runpane CLI, you do not need this guide or a code. [Workspaces](RUNPANE_WORKSPACES.md) put each desktop Pane on your tailnet automatically (port 8443) and trust your Tailscale login, plus everyone on the tailnet when a machine's owner allows it, so `runpane workspace <machine> read|write|exec|<command>` works between your Macs, Windows PCs, and Linux machines, and the desktop app's remote mode connects to them from the sidebar's machine menu or Settings → Remote Access → Switch to. Use the remote daemon and pairing codes in this guide for browsers and phones, and for devices outside your tailnet. The remote daemon keeps port 443, and the two run side by side.

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

To bring your own VM, create it yourself, then set it up as a Remote Pane host.
For a sandbox that Pane creates and manages, see
[Cloud sandbox (experimental)](#cloud-sandbox-experimental).

1. Create an Ubuntu 24.04 VM with any provider. Size it for the agents and
   builds you plan to run. It only needs inbound SSH. The daemon listens on
   loopback, and you reach it through Tailscale or an SSH tunnel.
2. SSH in as a regular user with `sudo`, not as `root`.
3. Install what your agents need on the VM: `git`, patched Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x) (for
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

## Pane Cloud (invite-only beta)

Pane Cloud is an always-on machine that Greenfield runs for you, so agents keep working with your computer
closed. In **Settings > Remote Access > Cloud sandboxes**, pick **Pane Cloud** under **Add cloud sandbox**:

1. **Sign In with GitHub** shows a one-time code; enter it on GitHub. Sign-in proves your GitHub identity and
   nothing more: Pane Cloud never receives your GitHub, Claude, Codex or Tailscale tokens. An account that is
   not invited yet sees "You're on the list".
2. **Create Machine** creates your seat's one machine (8 vCPU and 16 GiB bursts, 12 vCPU-hours a day, a 50 GB
   disk). A second machine for the same seat is refused.
3. **Open Tailscale Login** and sign in with your own Tailscale account. The machine joins your tailnet as a
   device you own, and Pane saves it as a host it connects to over Tailscale, with no code or password.
4. Sign in to GitHub and your agents on the machine itself, from its host terminal.

The machine's page (its **Details**) shows today's CPU budget, its Pane version with **Update Pane**, and every
operation Pane Cloud ran on it, with who asked and why. Pane Cloud can run only these named operations: create,
start, stop, delete, install or update a published Pane release, prepare to stop, and collect diagnostics. It
has no shell on the machine.

`PANE_CLOUD_URL` points a build at another Pane Cloud service, such as a local stub from
`packages/pane-cloud-contract`.

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
2. Go to `Settings > Remote Access` and click `Add a machine` at the end of `Switch to`.
3. Paste the full `pane-remote://...` code into `Connection Code`.
4. Click `Connect`.

If the tunnel is not reachable yet, Pane still saves the host and shows the connection error. Start the printed SSH/Tailscale tunnel and pick the saved host again from `Switch to` or the sidebar's machine menu.

### Terminal on the host

To sign in to tools such as `gh` or `codex` before you open a repository, open the host switcher and click the terminal button on the connected host's row ("Open terminal on <host>"). It opens a plain shell on the host, in its home folder, as the tab `<host> · Terminal`. Each host has one such terminal: closing the tab keeps the shell running, and opening it again brings back the same shell. The host keeps it in a hidden session under `<pane dir>/sessions/host-terminal`, so it never shows up as a repository or a Pane.

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

Who can open these pages: the devices that **Who can connect** admits (see [Who is trusted](RUNPANE_WORKSPACES.md#who-is-trusted)). Phone pages need that setting on, Tailscale running on the host, and the phone on the same tailnet. A page in a frame cannot send the machine's password, so phone pages are off while password protection is on. A refused device sees "This page runs on &lt;host&gt;. Open it from a device signed in as &lt;login&gt;." A pairing code or SSH tunnel does not grant access to these pages: they need the phone on this tailnet, signed in with a login that setting admits. Navigation inside a page stays on the phone; the tab saves only the addresses you enter or pick.

The Pane phone app shows page tabs with an address row (back, forward, address, reload, Open in Safari) and loads them through the same phone addresses. When the files address is off or the phone can't reach it, the app reads an HTML file through its own connection instead (`panels:read-browser-file`), so a self-contained page opens over a pairing code too; pages that load other files from their folder need the phone address. Entering an address saves it to the tab. Each case that can't load names its reason: nothing listens on the port, phone pages are off on that computer (with its reason), the phone is not on Tailscale, the computer is offline, or its Pane predates phone pages.

### Files on the phone

Each pane's Explorer tab shows its worktree as a tree. Tap a text file to read and edit it; Save writes it to the host. Text files over 1 MB, and binary files that are not images, PDFs, video or audio, stay on the desktop. Images, PDFs, video and audio of any size preview on the phone, and video seeks without downloading the whole file. Open in Safari opens a preview outside the app.

In the Pane phone app, Explorer lists the branch's changed files first, then opens one folder at a time with a path bar and search, and files are read-only: code with syntax colours, Markdown rendered or as source, and images up to 5 MB. Text over 1 MB and other binaries stay on the computer, with Copy path. Everything, images included, comes through the app's own connection, so it works over every connection the app supports. Editor tabs open their file in the same viewer. The Diff tab lists the branch's changes with their counts and shows each file's patch, and Run script tabs show the script's output live; both are read-only, so commit, revert and start or stop the script on the computer.

Browsing and editing go through the PWA's own connection, so they work over every connection the PWA supports. Previews load from the same Serve address as HTML files in browser tabs, so they need what [browser tabs on the phone](#browser-tabs-on-the-phone) need: Tailscale on the host, password protection off, and a phone signed in to a login that **Who can connect** admits. Without that, a preview explains why it cannot load. Files outside the worktree are refused.

### Remote PWA Implementation Notes

The Remote Pane PWA is a browser runtime. It does not have `window.electronAPI`, so client-side PWA preferences must use browser-safe storage such as `localStorage` or explicit daemon adapter calls. Do not reuse desktop renderer preference stores that persist through Electron IPC unless the call path is guarded for browser mode.

## Forwarded ports

A desktop connected to a remote host reaches every port listening on the host as if it were local. Pane lists the host's ports on a new, empty browser tab and under the address bar's **Ports** button, and the desktop opens a matching listener on its own `127.0.0.1` and `::1` for each one. Only the desktop app sets up these listeners; the browser app and phones don't yet.

- A browser tab at `localhost:5173` loads the host's dev server, live reload included. The address bar reads `localhost:5173` with **on &lt;host name&gt;**.
- When something on the desktop already answers on 5173, the desktop uses the next free port, or any free port when the next 19 are taken too. The tab still reads `localhost:5173`, and the Ports list shows the local number as **here :5174**.
- A tab never loads the desktop's own service in the host's place. While the host's Ports list is loading it waits, and when a port stops listening on the host it says the port isn't reachable, then loads once the port is back.
- **Copy URL** copies the address that works on the desktop, for its system browser.
- Clicking a `localhost` link in a terminal opens the host's server in your system browser, using the local port number if it moved. A link to a port that isn't forwarded right now doesn't open, so it never reaches the desktop's own service on that port.
- When a port closes on the host, the desktop closes its listener. Disconnecting closes all of them.

Each connection the desktop accepts travels over the Pane connection as a WebSocket to `/ports/<port>` on the host, which connects to `localhost:<port>` there. The host accepts it only with the same sign-in as every other request, and only for a port in its current list. Listeners stay on loopback on both machines.

Every client signed in to the host can reach these ports through that route: anyone holding a pairing code, and any Tailscale login that the Workspaces "Who can connect" setting allows. They reach every listening service, including databases that trust `localhost` and debugging ports such as a Node `--inspect` port, which runs code as you. Pane's own ports are forwarded too, and its remote API keeps its own sign-in. Forwarding can't be limited to some ports. If that is more access than you want, turn off the remote daemon listener in `Settings > Remote Access` and set "Who can connect" to Off.

## Security Model

- The daemon listener only supports loopback hosts: `127.0.0.1`, `::1`, or `localhost`.
- Direct public or LAN binding is intentionally rejected.
- Use SSH local forwarding, Tailscale Serve, or a trusted HTTPS reverse proxy that forwards to loopback.
- Treat the generated `pane-remote://...` code like a secret. It contains the bearer token needed by the local client.
- Any signed-in client can open a TCP connection to any port listening on the host. See [Forwarded ports](#forwarded-ports).

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

Use `Add a machine` under `Switch to` for a generated code, or use `Save existing remote profile` under `More > Advanced > Pairing tools` with:

- label
- base URL
- bearer token

Click `Save Remote Profile`, then pick the saved profile from `Switch to` or the sidebar's machine menu.

## Validation

Recommended checks after connecting:

1. Verify projects and sessions load in the client.
2. Open a terminal-backed session and confirm output streaming works.
3. Send terminal input and verify the remote runtime receives it.
4. Resize a terminal and confirm the remote terminal resizes.
5. Open a file and confirm read/write works.
6. Check git status and commit/diff flows.
7. Run an approve-mode command and confirm the permission dialog appears on the client.

## When a connection fails

When you connect to a host (Switch in Settings → Remote Access, Add a machine,
the sidebar's machine menu, or Retry), the main area shows a checklist of
the connection's stages. The first stage that fails shows what went wrong and a
fix. The same checklist appears when Pane gives up reconnecting after five
minutes, and from **Retry now** on the "Can't reach <machine>" banner. That
banner appears once the connection has been down for 10 seconds; until then
the workspace dims and the host dot pulses while Pane reconnects.

The host's 5-second heartbeat decides whether a connection is alive. One failed
request fails only itself; three requests in a row that get no answer reconnect.
Reconnects wait 250 ms, 750 ms and 2 s, then double up to 30 s between tries.

| Stage | Fails when | Fix |
|---|---|---|
| Tailscale on this computer (Tailscale machines only) | Tailscale is signed out or not installed here | Open Tailscale Setup, or Download Tailscale |
| Host reachable | The host times out or its name does not resolve; a Tailscale machine is offline | Check that both computers are on the same network or tailnet |
| Pane daemon running / Pane open | The host refuses the connection, or a proxy such as Tailscale Serve answers 502-504 | Start it, or Copy command |
| Signed in | The host rejects this computer's token or password | Paste new code, or Enter password |
| Versions match | The host runs a different Pane version (a warning; the workspace still loads) | Update it, or Update Pane on this computer |
| Workspace loaded | The host answered but the workspace did not restore | Retry |

**Start it** and **Update it** run one fixed command on the host over your own
SSH config. They appear only when exactly one `Host` alias in `~/.ssh/config`
matches the host: its Tailscale machine name, or the first label of the host
name in its address (`devbox` for `devbox.tail1234.ts.net`). Pane runs:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 <alias> "$SHELL" -lc '<command>'
```

`BatchMode` makes ssh fail instead of asking for a password, and the login
shell puts `npx` on the `PATH`. With no single matching alias, or when ssh
fails, the row offers **Copy command** so you can run the same command on the
host yourself:

| Fix | Code host (daemon) | Tailscale machine (Pane app) |
|---|---|---|
| Start it | `npx --yes runpane@latest daemon repair --yes` | `open -a Pane` (macOS hosts only; otherwise open Pane there) |
| Update it | `npx --yes runpane@latest update && npx --yes runpane@latest daemon repair --yes` | `npx --yes runpane@latest update` |

`daemon repair` uses the default daemon data directory, `~/.pane_remote`. For a
host set up with another `--pane-dir`, run `runpane daemon repair --pane-dir
<dir> --yes` there instead.

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

Pane's remote clients (desktop, browser, phone and glasses) retry a reviewed set
of read-only requests and dictation cleanup after transient network or server
failures, on the reconnect schedule for up to five minutes. Authentication
failures stop immediately.

A host on a current Pane runs each action once per request ID and says so when a
client connects (`deduplicatesRequestIds` in the `ready` event). It remembers
each client's recent IDs and answers for ten minutes, in memory, up to 10,000
per client; while a client is at that limit, the host refuses its new actions
before running them and the client sends them again. Against such a
host, every action a client sends (terminal input, prompts, new panes and tabs,
Notify answers) carries an ID. An action issued while the connection is
reconnecting waits for it; one whose answer is lost is resent with the same ID
until the host answers or five minutes pass since it was issued. Terminal
input keeps its order per terminal. Typing into a dimmed terminal is not queued.

Delivery is unknown only when no answer arrives in that time: inspect the
current panes or terminal before submitting it again. An action that was never
sent says so. Against an older host, actions other than chat sends (which the
host de-duplicates by operation ID) are sent once, as before.

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

The native companion registers an APNs/FCM token with every computer it has saved. With a paired bearer token, the registration is scoped to that paired client and revalidated before every send. Over Tailscale Serve with no code, only the computer's owner login can register; the registration is filed under `tailnet:<login>` and the phone's install id, checked when it registers, and lasts until the phone revokes it or the provider reports the token dead. One owner login keeps at most 10 live registrations per computer, dropping the oldest. The daemon sends attention alerts for `blocked` transitions and for settled `working → idle` transitions of turns a person started; controls can disable either category per device. See [Native mobile](NATIVE_MOBILE.md) for the operator-only credentials and signing setup.
