# Remote Daemon Lifecycle

This is the implementation checklist for Remote Pane setup, teardown, and runtime switching. It exists to keep config writes, runtime controller actions, and renderer refreshes in sync.

## Runtime Roles

- Host lifecycle is owned by `PaneRemoteTransportController` and `remoteHostRuntimeStateStore`.
- Client lifecycle is owned by `RemotePaneClientController`.
- IPC handlers in `main/src/ipc/remoteDaemon.ts` orchestrate config writes and controller calls.
- Renderer runtime changes are reconciled through `remote-daemon:resync-required`. Main sends `{ hostChanged: true }` when the active runtime changes; a reconnect to the same host sends it without a payload.
- A resync refetches config, Panes, the active Pane's panels, repositories, Sessions and pinned Sessions, pending permission prompts, loaded archived Panes, archive progress, the host's terminal shells, and an open Usage view. When the host changed, it also leaves an open repository view, since repository ids are per host, loads that host's expanded repositories, and asks again about that host's interrupted Panes.
- Expanded repositories are saved per host: this computer under `treeView.expandedProjects`, a remote host under `treeView.expandedProjects@<profile id>`.
- Where the user was is saved per host too, under `navigation.lastLocation` / `navigation.lastLocation@<profile id>`: the active view, the open repository view's project id, and the open Pane. A switch clears the outgoing host's selection as above and then restores the incoming host's, validating every id against that host's freshly loaded repositories and Panes — anything archived or gone degrades to the home view, and the dead memory is overwritten rather than retried. `frontend/src/utils/hostNavigationMemory.ts` owns both halves; the renderer names the host on each read and write, because it can still be showing the outgoing host while main has already switched runtimes. Restoring selects one Pane, as a click would, and never revives every terminal once open on that host. Two things are deliberately not in the memory: the tab inside a Pane, which the host already records as `panel.state.isActive` and the resync's panel load brings back, and the selected Session, which is the host's own state adopted by the resync. The memory is not applied at app startup; only a host switch reads it.
- The terminal shell picker reads and writes the active host's shell (`terminal:get-shell-settings`, `terminal:set-preferred-shell`). It appears only when that host runs Windows.
- `pane:focus-requested` and `pane:open-link` are host events: an agent's `runpane panes focus` on the active host moves the client's view, and one on this computer does not while a remote host is active. A pane:// link opened on a remote-mode client is resolved by its renderer against the active host.
- Remote terminals ack output with `terminal:ack`. This window's ptyHost port reaches only local terminals.
- The Remote Pane PWA keeps the same rules in the browser. When its event stream returns after a drop (network loss, or the native app resuming), it refetches Panes, the selected Pane's panels, Sessions, and loaded archived Panes. Connecting to a host or disconnecting clears all host-scoped state first: Panes, panels, Sessions, the open Session, archived Panes, open dialogs, and notification settings.

## Lifecycle Matrix

| Action | Main-process side effect | Renderer side effect |
| --- | --- | --- |
| Import connection and connect succeeds | Activate profile, save/dedupe profile, set remote mode | Resync config, sessions, panels |
| Import connection and connect fails | Save/dedupe profile, keep current active runtime | No runtime resync |
| Connect saved profile | Activate profile before persisting remote mode | Resync config, sessions, panels |
| Switch to local runtime | Disconnect active remote client, save local mode | Resync config, sessions, panels, clear stale active session |
| Delete inactive profile | Remove profile | No runtime resync |
| Delete active profile | Switch local, remove profile, save local mode | Resync config, sessions, panels |
| Enable or update host | Save host config, transport controller syncs to live or error | Host-state event updates UI |
| Stop host | Save disabled host config, transport controller stops server | Host-state event updates UI |
| Disconnect host clients | Drop matching SSE clients | Host-state event updates client count |
| Revoke host client | Remove saved client record, drop matching SSE clients | Host-state event updates client count |

## Guardrails

- Do not persist remote mode until the selected profile has successfully activated.
- Failed import-connect saves the profile but must not switch runtime or emit a renderer resync.
- Connected remote clients are runtime state, not saved client records.
- Current Pane Data hosting is live only while that Pane app is running.
- Isolated daemon data can install a background service; Current Pane Data should not.

## Terminal Input

Desktop and browser clients send at most one terminal input request per panel at a time. Keys typed while a request is pending are combined into the next request, preserving their order without a separate round trip for every buffered key. A bare Escape always ends a combined request, because terminal apps read Escape followed by another key in the same write as an Alt shortcut. Different panels and other remote commands remain independent.

Input requests are not retried. On failure, disconnect, or a ten-second input timeout, queued input is discarded and outstanding callers are rejected. An interrupted request may already have reached the host, so its input must not be replayed after reconnecting. This uses the existing HTTP API and requires no host protocol upgrade.

## Desktop browser file previews

Before mounting a `file://` webview, the desktop renderer asks the local main process to prepare its session. In remote mode, an isolated in-memory Electron partition handles every file request through `panels:read-browser-file` on the existing authenticated remote connection. The original URL, including its filename, remains intact, so relative CSS, images, scripts and linked HTML pages resolve normally. Local-mode previews retain their ordinary project partition. This does not add browser panels to the Remote PWA.

The host reader requires an existing browser panel whose saved entry URL identifies a regular file. It serves regular files within that entry page's directory and descendants, with a 16 MiB limit per file. It checks canonical paths to reject traversal and symlinks/junctions outside that directory at validation time; it never lists directories. The host filesystem is trusted: these checks do not guarantee atomic containment against a host process maliciously replacing files or directories during a read. Thus opening a file shares its containing bundle directory with connected clients, not the entire worktree or disk. This endpoint has no caller-supplied root. File entry URLs are host-owned: HTTP command provenance is carried through async handlers, and the panel manager rejects remote attempts to create or retarget file previews (including through RunPane). Clients can update an unchanged entry but must open a new file on the host.

Remote file navigation is client-local and does not overwrite the host's saved entry URL. This keeps nested page navigation from changing the bundle boundary. Missing/deleted panels revoke reads; changing the connected profile or its base URL invalidates the previous session's requests, including responses already in flight. A failed fetch renders an error message and never falls back to the client's filesystem. Both desktop client and host need this version; an older host reports an unavailable preview.

Run `pnpm build:main`, start the frontend with `pnpm --filter frontend dev`, then set `PANE_ELECTRON_E2E=1` and run `pnpm exec playwright test tests/remote-browser-files.spec.ts`. Set `PLAYWRIGHT_PORT` if using a different dev-server port. This opt-in Electron regression uses isolated temporary Pane data and a loopback host with the production HTTP/SSE transport. It verifies the actual BrowserPanel, CSS/image loads, linked-page navigation, the preserved filename, access denial and disconnect behavior, and saves `remote-client-rendered.png`. Linux requires a display (for example Xvfb).
