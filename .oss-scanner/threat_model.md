# Pane threat model

Pane is an Electron desktop app for running coding agents (Claude Code, Codex,
Cursor and others) in parallel git worktrees. Each agent runs in a real
terminal with the user's shell access. Pane also runs a local daemon that the
`runpane` CLI and the `pane` MCP server talk to, and it can optionally serve
the Remote Pane web app (PWA) and other machines over Tailscale. Phones reach
it through the PWA, its Capacitor shell (`mobile/`) and a React Native
companion app (`native/`).
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) shows how the processes fit
together.

The person running Pane is trusted: they chose the repository, typed the
commands and started the agents. The attacker we care about controls
something that person did not write. That could be a repository's contents, a
pull request or issue, an agent's output, a web page in a browser panel, a
device on the network, or another local process.

## Where untrusted input enters

| Input | Who controls it | Where it lands |
| --- | --- | --- |
| Repository contents: files, branch names, git config, `pane.json` / `conductor.json` / `.gitpod.yml` / `.devcontainer/devcontainer.json` | Whoever wrote the repo or the PR branch | `main/src/services/worktreeManager.ts`, `main/src/services/projectConfigDetector.ts`, `main/src/ipc/file.ts`, `main/src/ipc/git.ts`, the file previews (`main/src/services/mediaPreview.ts`, `filePreviewListing.ts`) |
| Terminal output from agents and processes | The agent, or anything it read (prompt injection) | `main/src/services/terminalPanelManager.ts`, `terminalStateEmulator.ts`, `agentStatus/`, the renderer's xterm.js and log views (`frontend/src/components/panels/logPanel/LogsView.tsx`) |
| Rendered file content: Markdown, notebooks, HTML, CSV, archives, SQLite files | The repo | `frontend/src/components/panels/editor/` (for example `NotebookPreview.tsx`, sanitised with DOMPurify), `pane-media` protocol in `main/src/services/mediaPreview.ts` |
| Web pages in browser panels (`<webview>`) | Any site, or a dev server in the worktree | `main/src/index.ts` (`will-attach-webview`, window-open handler), `main/src/services/webviewPreferences.ts`, `webviewPopups.ts` |
| `pane://` deep links | Any web page or app that can open a URL | `main/src/services/paneLinks.ts` (`parsePaneLink`, `registerPaneLinkHandler`) |
| Local daemon socket / named pipe | Any process running as the same OS user | `main/src/daemon/server.ts`, `socketPath.ts`, `socketFraming.ts`, `commandRegistry.ts`; the CLI side is `packages/runpane/src/daemonClient.ts` |
| Remote HTTP / WebSocket / SSE API | Paired phones and browsers; anyone who can reach the port | `main/src/daemon/httpApiServer.ts`, `auth.ts`, `remotePairing.ts`, `previewProxy.ts`, `phonePreviews.ts` |
| Tailscale workspaces (port 8443) | Other machines and people on the tailnet, per the owner's visibility setting | `main/src/daemon/workspaceHost.ts`, `auth.ts` (`authenticateWorkspaceRequest`), `workspacePassword.ts`, [docs/RUNPANE_WORKSPACES.md](../docs/RUNPANE_WORKSPACES.md) |
| `pane-remote://` connection codes (pasted, tapped or scanned as a QR code), and host responses and SSE events seen by the phone apps | Whoever made the code or link; a host or network path the phone talks to | `shared/remoteClient/` (`pairing.ts`, `remoteDaemonClient.ts`, `storage.ts`); in the native app `native/src/features/pairing/deepLink.ts`, `ConnectForm.tsx`, `native/src/auth/secureStore.ts`, and the terminal WebView and its message bridge (`native/src/features/terminal/TerminalWebView.tsx`, `bridge.ts`) |
| Pull request state, checks and review comments that Pane polls | Anyone who can open, push to or comment on a PR | `main/src/services/sessionPrMonitor.ts`, `githubWatchClient.ts` (GitHub GraphQL with the user's `gh` token); agents also read PR and issue text themselves |
| Update metadata and downloads | The release feed, or whoever sits on the network path | `main/src/autoUpdater.ts` (electron-updater, GitHub provider); `packages/runpane/src/download.ts`, `updateArtifacts.ts` (SHA-256 manifest check) |

## In scope

All of Pane's own code: `main/`, `frontend/`, `shared/`, `packages/runpane`
and `packages/runpane-py`, the React Native companion in `native/`, and
`mobile/` where it differs from `frontend/`. The parts that matter most:

1. **Main process and IPC.** The renderer is sandboxed with context isolation
   and reaches the main process only through `main/src/preload.ts`. The
   handlers in `main/src/ipc/` and the daemon's command registry trust the
   renderer. So a renderer compromise is a full compromise (file access,
   process spawning). Any way for repo content, agent output, a webview or a
   remote client to run script in the renderer is critical.
2. **The `runpane` CLI and the daemon channel.** The socket's directory is
   `0700` and the socket is `0600` (`main/src/daemon/server.ts`). There is no
   further handshake, by design: a process running as the same user is
   already trusted. Report a way for another OS user, a sandboxed process or a
   web page to reach that channel, or to make the CLI or `runpane mcp` act on
   input it should refuse.
3. **The remote / PWA server.** Pairing tokens are random, stored as SHA-256
   hashes and compared in constant time (`main/src/daemon/auth.ts`).
   Workspace mode trusts the `Tailscale-User-Login` header that
   `tailscale serve` sets, plus an optional scrypt password. Report anything
   that gets past these checks, reaches the terminal or file APIs without
   them, crosses from one paired client to another, or reaches a service
   outside what `previewProxy.ts` admits.
4. **Terminal and PTY handling.** PTYs spawn through node-pty
   (`main/src/ptyHost/ptyHostMain.ts`, `ptyHostSupervisor.ts`,
   `terminalPanelManager.ts`). Report escape sequences or output that execute
   anything, write files, or inject keystrokes or commands into a terminal
   that the user did not type. Also report output that breaks the
   emulator's or the renderer's handling of it.
5. **Worktree and git operations.** Git runs through `execFile` with
   argument arrays (`worktreeManager.ts`), and branch names go through
   `git check-ref-format`. Report argument or option injection, and paths
   that escape the worktree in file reads, writes, previews or `pane-media`
   URLs (`main/src/ipc/file.ts`, `mediaPreview.ts`). Archive and SQLite
   listing parsers (`filePreviewListing.ts`) are in scope.
6. **The update path.** Anything that gets Pane or `runpane` to install a
   build that did not come from the project's GitHub releases.
7. **Embedded browser.** Webviews are forced to `sandbox`,
   `contextIsolation` and no preload (`webviewPreferences.ts`). Pages
   reach the outside world through popups and `shell.openExternal`
   (`main/src/index.ts`, `webviewPopups.ts`). Report escapes from that
   sandbox into the app.
8. **Stored secrets.** The SQLite database, pairing records and workspace
   passwords (`main/src/database/`, `main/src/daemon/remotePairing.ts`,
   `workspacePassword.ts`).
9. **The phone clients.** The native app (`native/`) and the PWA hold a
   host's bearer token and send it only in the `Authorization` header
   (`shared/remoteClient/`, `native/src/auth/secureStore.ts`). A
   `pane-remote://` link only fills in the pairing screen; the person confirms
   before it connects (`native/src/features/pairing/deepLink.ts`). The
   terminal renders host output in a WebView that talks to the app over a
   message bridge (`native/src/features/terminal/`). Report anything that
   leaks a token (to logs, URLs, another host or another app), pairs or
   connects without that confirmation, or lets host output or a malicious
   host run script in the app or drive the bridge.

## Out of scope

- **The agents Pane launches** (Claude Code, Codex, Cursor and others): their
  own permission prompts, sandboxes and behaviour. That an agent with shell
  access can run commands is the product. Report a bug in Pane's handling of
  agents, not in the agents.
- **Scripts the repository asks for.** Pane runs a repo's setup and run
  scripts from `pane.json`, `conductor.json`, `.gitpod.yml` or
  `devcontainer.json` (`main/src/ipc/project.ts`, `main/src/ipc/session.ts`),
  as Conductor and dev containers do. Opening a repository in Pane trusts it
  as much as running its scripts would. A way to run code from a repo that
  defines no such script, or from a file Pane only displays, is in scope.
- **Anyone already running code as the same OS user**, with the access that
  gives them. They can already read Pane's data and drive its socket.
- **Third-party dependencies** (Electron, Chromium, node-pty, xterm.js,
  better-sqlite3, Tailscale and npm packages), unless Pane uses them unsafely.
  Report upstream bugs upstream.
- **Workspace access the owner granted.** Under "Everyone on tailnet",
  everyone on the tailnet gets `write` and `exec` by design.
- The marketing site and anything not in this repository.
- `deploy/remote-pwa/` beyond the static files it serves.

## How to exercise it

The image has dependencies installed, everything built, and the Node build of
better-sqlite3 in place. Nothing needs the network.

- Unit tests: `pnpm --filter main exec vitest run` (about 2,750 tests, including
  the daemon, auth, pairing, proxy and IPC handlers) and
  `pnpm --filter frontend test`. A single file:
  `pnpm --filter main exec vitest run src/daemon/auth.test.ts`.
- The native app's plain TypeScript modules (pairing, terminal sessions, the
  controller): `pnpm --filter @pane/native test`.
- The CLI: `node packages/runpane/dist/cli.js --help`.
- Electron: run `pane-sqlite-abi electron` first, then start it under Xvfb
  as root with `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a pnpm exec electron --no-sandbox .`
  (set `PANE_DIR` to a scratch directory; the image sets
  `PANE_DIR=/tmp/pane-scan`). The headless daemon is
  `pnpm exec electron --no-sandbox ./main/dist/main/src/daemon/headless.js`.
  Run `pane-sqlite-abi node` before going back to the unit tests.
- Good test doubles to start from: `main/src/daemon/httpApiServer.test.ts`,
  `server.test.ts`, `previewProxy.test.ts`, `main/src/ipc/file.session.test.ts`,
  `main/src/services/paneLinks.test.ts`.

## How we rate severity

- **Critical:** code execution, or reading or writing arbitrary files, with
  no user action beyond normal use. Examples: from a remote or network peer
  without valid pairing; from a web page through a `pane://` link or a
  browser panel; from a repository, PR or issue that Pane only displays or
  checks out. Also: getting past remote auth to reach terminals or files, and
  installing an update that did not come from our releases.
- **High:** the same outcomes but needing one ordinary user action (opening
  a file preview, clicking a link in terminal output). Script execution in the
  renderer. Path traversal outside the worktree. Command or option injection
  into git or a spawned process. One paired client reaching another's data.
  Leaking pairing tokens or workspace passwords.
- **Medium:** keystroke or command injection into a terminal that needs the
  user to press Enter. Reading files the user did not open but that stay inside
  their worktrees. Spoofing what Pane shows about an agent's state or a
  command's origin in a way that leads to a harmful approval. Denial of
  service reachable from the network.
- **Low:** local denial of service (a crafted file that hangs a preview or a
  terminal), information leaks with no clear use, and missing hardening that
  has no demonstrated exploit.

A finding without a working proof of concept is capped one level below where
it would otherwise land.

## Reports and patches

Please send:

1. One or two sentences on the impact: who the attacker is, what they control
   and what they get.
2. A minimal proof of concept: the smallest repo, file, link, request or byte
   sequence that shows it, and the command that runs it in this image.
   A failing vitest test next to the affected module is ideal.
3. A candidate patch as a unified diff against `main`, as small as it can be,
   with a test that fails before it and passes after. Follow the existing code:
   no new dependencies, and errors raised as `PaneError` with a `code` and
   `next` (see [CONTRIBUTING.md](../CONTRIBUTING.md#how-pane-reports-errors)).

One finding per report. If several findings share a root cause, report them
together.

## Leave alone

- The Windows- and macOS-only paths (named pipes, WSL, `codesign`, the
  universal-binary checks) cannot run in this Linux image. Read them, but do not
  report "does not work on Linux". The same goes for the iOS and Android
  builds of `native/` and `mobile/`: read their source and run the native
  Vitest suite, since the apps themselves cannot start in this image.
- Test fixtures and `__fixtures__/` directories with deliberately hostile
  content.
- Development scripts under `scripts/` that only maintainers run, unless one
  is reached from the app.
