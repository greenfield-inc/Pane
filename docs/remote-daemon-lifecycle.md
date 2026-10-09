# Remote Daemon Lifecycle

This is the implementation checklist for Remote Pane setup, teardown, and runtime switching. It exists to keep config writes, runtime controller actions, and renderer refreshes in sync.

## Runtime Roles

- Host lifecycle is owned by `PaneRemoteTransportController` and `remoteHostRuntimeStateStore`.
- Client lifecycle is owned by `RemotePaneClientController`.
- IPC handlers in `main/src/ipc/remoteDaemon.ts` orchestrate config writes and controller calls.
- Renderer runtime changes are reconciled through `remote-daemon:resync-required`. Main sends `{ hostChanged: true }` when the active runtime changes; a reconnect to the same host sends it without a payload.
- A resync refetches config, Panes, the active Pane's panels, repositories, Sessions and pinned Sessions, pending permission prompts, loaded archived Panes, archive progress, the host's terminal shells, and an open Usage view. When the host changed, it also leaves an open repository view, since repository ids are per host, loads that host's expanded repositories, and asks again about that host's interrupted Panes.
- Expanded repositories are saved per host: this computer under `treeView.expandedProjects`, a remote host under `treeView.expandedProjects@<profile id>`.
- Where the user was is saved per host too, under `navigation.lastLocation` / `navigation.lastLocation@<profile id>`: the active view, the open repository view's project id, and the open Pane. A switch clears the outgoing host's selection as above and then restores the incoming host's, validating every id against that host's freshly loaded repositories and Panes — anything archived or gone degrades to the home view, and the dead memory is overwritten rather than retried. `frontend/src/utils/hostNavigationMemory.ts` owns both halves; the renderer names the host on each read and write, because it can still be showing the outgoing host while main has already switched runtimes. Restoring selects one Pane, as a click would, and never revives every terminal once open on that host. The memory also holds this desktop's selected Session: launch and host switches both restore it, and the host's last-used Session is only the fallback when there is none. Another client's selection never moves it. The tabs and split inside each Pane are a separate per-Pane memory, `paneLayout.<pane id>` / `paneLayout.<pane id>@<profile id>` (`frontend/src/utils/paneLayoutMemory.ts`); the host's stored layout and active tab are the last used by any client and seed a Pane this desktop has not shown. Archiving or deleting a Pane drops its memory. Apart from the Session, the location memory is not applied at app startup; only a host switch reads it.
- The terminal shell picker reads and writes the active host's shell (`terminal:get-shell-settings`, `terminal:set-preferred-shell`). It appears only when that host runs Windows.
- `pane:focus-requested` and `pane:open-link` are host events. `runpane panes focus` and `runpane panes create --focus` move only the desktop window attached to that host as its local host; a remote-mode client ignores them. A host- or agent-initiated tab activation (`panel:activeChanged`) moves only clients already showing that Pane, and a new Pane switches only the client whose request created it (`clientRequestId`, echoed on `session:created`). A pane:// link opened on a remote-mode client is resolved by its renderer against the active host.
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

## Desktop media previews

The explorer's previews (images, PDFs, fonts, video, audio and the text formats) work from a remote desktop. The renderer still gets a `pane-media://preview/<token>` URL from its own main process; the grant records which host issued it, and a request after a host switch, or after a switch to local mode, gets 403. Each request goes to the host's `GET /media?sessionId=&filePath=` with the connection's usual authentication on that door, and its `Range` header passes through, so video and audio seek without downloading the whole file. The host checks that the path has a preview kind and resolves it through `file:getPath`, the same worktree and symlink boundary the host uses for its own previews, and answers 404 otherwise. Archive and SQLite listings use the daemon-owned `file:preview-list` command, so they run on the host too. "Open with system app" on a remote desktop downloads the whole file through the same route into a new temporary folder on that desktop and opens the copy, so edits in the system app do not reach the host. The copy keeps the host file name when that name is valid on every desktop OS, and is otherwise named `preview` plus the extension. A failed download or open removes the folder. While remote mode has no connected host, previews and Open fail; they never read the desktop's own files. "Reveal in folder" is available only on the host.

## Desktop browser file previews

Before mounting a `file://` webview, the desktop renderer asks the local main process to prepare its session. In remote mode, an isolated in-memory Electron partition handles every file request through `panels:read-browser-file` on the existing authenticated remote connection. The original URL, including its filename, remains intact, so relative CSS, images, scripts and linked HTML pages resolve normally. Local-mode previews retain their ordinary project partition. This does not add browser panels to the Remote PWA.

The host reader requires an existing browser panel whose saved entry URL identifies a regular file. It serves regular files within that entry page's directory and descendants, with a 16 MiB limit per file. It checks canonical paths to reject traversal and symlinks/junctions outside that directory at validation time; it never lists directories. The host filesystem is trusted: these checks do not guarantee atomic containment against a host process maliciously replacing files or directories during a read. Thus opening a file shares its containing bundle directory with connected clients, not the entire worktree or disk. This endpoint has no caller-supplied root. File entry URLs are host-owned: HTTP command provenance is carried through async handlers, and the panel manager rejects remote attempts to create or retarget file previews (including through RunPane). Clients can update an unchanged entry but must open a new file on the host.

A host switch removes cached browser panels before asynchronous resync, so outgoing URLs and partitions cannot survive even when both hosts have identical panel IDs. Panel-list requests carry a host generation and refetch if their response belongs to an outgoing host. Incoming panel data recreates the guest and prepares its file session anew. While file preparation is unresolved, navigation does not mount a guest or persist URLs; starting preparation also cancels earlier pending URL writes. Remote file navigation is client-local and does not overwrite the host's saved entry URL. This keeps nested page navigation from changing the bundle boundary. If the host replaces the file entry with an HTTP(S) URL, the client returns to its ordinary project session and navigation persistence, including when it was already viewing that HTTP page. Missing/deleted panels revoke reads; changing the connected profile or its base URL invalidates the previous session's requests, including responses already in flight. A failed fetch renders an error message and never falls back to the client's filesystem. Both desktop client and host need this version; an older host reports an unavailable preview.

Run `pnpm build:main`, start the frontend with `pnpm --filter frontend dev`, then set `PANE_ELECTRON_E2E=1` and run `pnpm exec playwright test tests/remote-browser-files.spec.ts`. Set `PLAYWRIGHT_PORT` if using a different dev-server port. This opt-in Electron regression uses isolated temporary Pane data and a loopback host with the production HTTP/SSE transport. It verifies the actual BrowserPanel, CSS/image loads, linked-page navigation, the preserved filename, access denial and disconnect behavior, and saves `remote-client-rendered.png`. Linux requires a display (for example Xvfb).
