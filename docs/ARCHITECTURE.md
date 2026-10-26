# Pane architecture

This is an index of how Pane fits together. It names the owning files; the code
is the reference for details.

## Renderer preference boundary

Use `API.preferences.get(key)`, `getAll()`, and `set(key, value)` instead of generic IPC invokes. The preload's `preferences` methods validate host responses through `shared/types/preferences.ts` before returning values. A missing key returns `null`, an empty value remains `''`, and all preference values are strings. Failed or malformed responses reject; callers retain their existing loading/error handling. The frontend API forwards these typed values without parsing IPC envelopes again.

## Words

- **Repository (project):** a saved base git repo.
- **Pane (session):** one feature or PR workspace. It normally owns one
  Pane-managed git worktree and branch.
- **Panel:** a tab inside a pane. Types are `terminal`, `diff`, `explorer`,
  `editor`, `logs`, `dashboard`, `setup-tasks`, `browser` and `notes`
  (`shared/types/panels.ts`). Agent CLIs run in `terminal` panels.

## Processes

```
renderer (frontend/, React)  ──IPC via preload──▶  main process (main/src)
                                                     │  services, SQLite, git
remote PWA / mobile ──HTTP + SSE──▶ daemon ◀──socket── runpane CLI
                                                     │
                                                 ptyHost (optional utility process)
```

- **Main process** (`main/src/index.ts`) owns native integration, git
  worktrees, CLI processes and persistence. Business logic lives in
  `main/src/services/`; IPC handlers live in `main/src/ipc/`.
- **Preload** (`main/src/preload.ts`) is bundled with esbuild because the
  renderer is sandboxed (`scripts/verify-sandboxed-preload.js` checks it). It
  sends each invoke either to the main process or to the daemon, decided by
  `isDaemonOwnedChannel` in `shared/types/daemon.ts`. Keep ownership lists in
  that module, and run `pnpm build:main` to check the bundle still loads.
- **Renderer** (`frontend/src`) is React with Zustand stores
  (`frontend/src/stores`). `frontend/index.html` is the desktop app;
  `frontend/remote.html` is the Remote PWA that `mobile/` also bundles.
- **Daemon** (`main/src/daemon`) serves the command registry over a local
  socket (a `pane-daemon-*` directory under the system temp directory, or a
  named pipe on Windows). The `runpane` CLI talks to it. For Remote Pane it also
  serves HTTP and SSE (`httpApiServer.ts`), and the same server, behind
  `tailscale serve` on port 8443, gives your other machines `runpane workspace`
  and codeless desktop remote mode (`workspaceHost.ts`,
  `services/tailnetMachines.ts`, [RUNPANE_WORKSPACES.md](RUNPANE_WORKSPACES.md)).
  Who it admits is the visibility and optional password in `auth.ts`.
  `pnpm daemon:headless` runs it
  without a window. Remote setup and lifecycle:
  [SELF_HOSTED_REMOTE_DAEMON.md](SELF_HOSTED_REMOTE_DAEMON.md) and
  [remote-daemon-lifecycle.md](remote-daemon-lifecycle.md).
- **ptyHost** (`main/src/ptyHost`) runs PTYs in an Electron utility process.
  It is on by default on Windows (`usePtyHost` in `configManager.ts`), and
  `PANE_USE_PTY_HOST=1` turns it on elsewhere. Otherwise PTYs run in the main
  process. See [troubleshooting/WINDOWS_APP_HANG.md](troubleshooting/WINDOWS_APP_HANG.md).

## Terminal output

PTY output goes through `terminalPanelManager.ts`, which batches it and applies
flow control. It feeds a headless xterm emulator (`terminalStateEmulator.ts`),
whose serialization restores a terminal when its panel is shown again, and
stores capped scrollback in the `panel_buffers` table. The renderer draws with
xterm.js in `frontend/src/components/panels/TerminalPanel.tsx`. The comment
above that component describes the activation lifecycle; read it before you
change how panels show, hide or refresh.

Agent status (working, idle, blocked) is derived in
`main/src/services/agentStatus/`.

## File previews

`FileEditorView.tsx` routes editor tabs from the Files inspector, terminal links,
and `runpane panels open --file` using `shared/utils/filePreview.ts`. Supported
formats open read-only; ordinary code and text, HTML included, retain the editor
and auto-save.
Images, PDFs, fonts, video and audio load through `pane-media`, registered in
`main/src/services/mediaPreview.ts`. A revocable URL grants access to one file;
each request rechecks the existing worktree/symlink boundary through
`file:getPath`. `mediaStream.ts` streams byte ranges from disk. File bodies do
not pass through text/base64 IPC. On a remote desktop, the URL is bound to the
connected host, and each request streams from the host's authenticated `/media`
route with the same boundary check and byte ranges. Archive and SQLite listings
(`file:preview-list`) run on the host. "Open with system app" on a remote desktop
copies the file to a temporary folder on that desktop and opens the copy;
"Reveal in folder" appears only on the host.

HTML is not a preview format. Clicking an `.html`/`.htm` file in the Explorer,
or its Eye button, opens it rendered in a browser tab: the tab already showing
that file, or else a new one (a tab showing anything else is never retargeted).
The "Open HTML files" setting (Settings → General) switches Explorer clicks to
editable source, and an HTML file's right-click menu offers both "Open preview
in browser" and "Open as file". A browser tab showing a worktree file offers
"View source", and an HTML editor tab offers "Preview", which works like a click. `panels open --file` always
opens the source; `--url file://...` renders.

Markdown, CSV/TSV and structured text fetch at most 1 MiB. Markdown renders
with a source toggle.
Tables display at most 500 data rows and 100 columns. JSON/JSONL are formatted;
YAML/TOML retain source formatting in read-only Monaco with folding. Fonts use
a temporary FontFace specimen. Decode failures offer system open/reveal actions.

`filePreviewListing.ts` lists ZIP central directories (up to 4 MiB) and TAR
headers without extraction, with at most 1,000 entries. ZIP64/split ZIP and
compressed TAR are unsupported; extended TAR names are not expanded. SQLite
lists tables/views from a bounded temporary copy (32 MiB), opened read-only and
removed afterward. Nonempty WAL and rollback journals are refused before and
after copying beside the canonical target; hard-linked databases are refused
because their recovery-file owner path is ambiguous. No source sidecars are
created. Native schema inspection runs in
a child process with a 3-second deadline, a 1 MiB output cap and at most 1,000
displayed entries. No table data queries are executed.

`file:read` samples at most 8 KiB before decoding UTF-8. Binary files show a
read-only notice, and `file:write` refuses to overwrite binary content as text.
Preview components never enter the editable auto-save path, even on errors.

## Data

- The data directory is `~/.pane` for an installed app. `--pane-dir` or
  `PANE_DIR` overrides it (`main/src/utils/appDirectory.ts`).
- `sessions.db` is SQLite in WAL mode. The base schema is
  `main/src/database/schema.sql`; later changes are inline migrations in
  `main/src/database/database.ts` that run at startup. These guarded upgrades inspect
  the existing schema (for example with `PRAGMA table_info` and `sqlite_master`);
  there is no migration-version table or numbered SQL-file runner. For schema
  changes, update the fresh-install schema and the guarded `runMigrations()`
  upgrade, preserving ordering across table rebuilds. Verify fresh and older
  databases in isolated tests; a standalone SQL file does not run an upgrade.
- `config.json` holds app settings (`main/src/services/configManager.ts`,
  types in `main/src/types/config.ts`).
- Worktrees go in `<repo>/worktrees/` unless the project sets another folder
  (`worktreeManager.ts`). A worktree on a remote-tracking base fetches that
  branch first (`worktreeBaseRefresh.ts`: capped at about 10 s, shared by
  concurrent creates, never fails the create). `worktreePoolManager.ts` keeps
  empty reserve worktrees on `_reserve/<hex>` branches so new panes open fast;
  a reserve is only claimed while its base ref still points at its commit.
- Archive cleanup intents live in SQLite's `archive_cleanup_jobs`, atomically
  committed with the session archive flag. `ArchiveCleanupManager` resumes only
  those intents, validates physical directory/Git identity, and serializes work
  per repository with two global slots. Awaited, cooperative purge batches use
  Electron's `original-fs` and job-level busy retries. There are no detached
  deletion helpers or timed-out deletions left running. Failed jobs remain
  visible through ArchiveProgress; interrupted scripts require explicit skip
  on retry. Create/remove and pool background mutations share FIFO repository
  admission with no waiter timeout; archive scripts and purge run outside it.
  Known process trees are captured before committing intent. Teardown preserves
  PTY retirement cleanup, escalates freshly matched process identities, and
  verifies exit before touching files. Survivors remain in the job across
  restart and Retry; missing captures and snapshot errors fail closed.
  Process-table reads are confined to archive preparation/teardown/retry, each
  subprocess bounded to five seconds. Windows uses kernel start times and
  pinned process handles; POSIX revalidates start times before individual signals.
  Create/remove also check the cleanup path guard;
  Restore is blocked until cleanup completes. Quarantine lives under
  `<git-common-dir>/pane-archive-cleanup`, separate from legacy trash sweeps.
- Per-repo setup, run and archive scripts come from `pane.json` and friends:
  [CONFIG_FILES.md](CONFIG_FILES.md).

## Notes

Local Notes panels use `main/src/services/notes.ts` through `main/src/ipc/notes.ts`.
Canonical documents live in `<PANE_DIR>/notes/notes.json`, outside disposable
worktrees. A revision check rejects stale edits; writes atomically replace the
store. Promotion changes the canonical scope and retains references to earlier
scopes. The Session view derives associated project notebooks from existing Pane
associations. Renderer recovery drafts retain edits when an autosave fails. The borderless
editor inserts text/drawing blocks through inline plus or slash menus; the
settings cog holds promotion and deletion actions. Agent visibility is automatic
within scope, with no sharing controls in the editor. Restoring an archived
Pane refreshes its derived context from current project notes.

`noteExports.ts` derives marked instruction sections and drawing assets from saved
documents. Excalidraw scenes remain editable JSON, with PNG previews and readable
labels in agent-facing Markdown. Global destinations are Claude's user
`CLAUDE.md`, Codex's user `AGENTS.md` (or existing override), and Cursor's local
`rules/pane-memories.mdc`. Cursor CLI also receives the generated memory through
a user `sessionStart` hook (`cursorNoteHook.ts`), preserving existing hooks.
Scoped content is exported outside repositories to
`<PANE_DIR>/notes/contexts/<pane-id>.md`. Each new native Pane terminal receives
its path through `PANE_NOTES_FILE`; the user-level integration tells agents to
read that file before each turn. Project contexts contain only that project's
notes plus the current feature; Session contexts contain only Session notes.
Ordinary saves leave repositories clean. The existing `managedAgentsMd` opt-in
additionally exports scoped notes into repository `AGENTS.md` and `CLAUDE.md`;
turning it off removes those memory sections.

Exports preserve symlinks and permissions and replace files atomically. A store
ownership marker prevents a second Pane data directory from overwriting the
first directory's user memory. Malformed marker pairs produce a visible error.
Changing notebooks only reads data. Terminals predating this update need reopening
to gain the context environment variable. After the first scoped note, start a
new agent conversation to load the scoped-reading instruction. Global-file changes refresh on Codex's next
turn, Claude resume, or a new Cursor conversation in the tested CLI versions;
updating a file alone cannot erase context already read. Notes support native
macOS, Windows, and Linux installations; WSL agent exports report an unsupported
destination instead of claiming delivery. There is no cross-machine sync.

## Subsystems

| Area | Owner | Doc |
| --- | --- | --- |
| Adding an agent CLI | `main/src/services/agents/` | [ADDING_NEW_CLI_TOOLS.md](ADDING_NEW_CLI_TOOLS.md) |
| Panels | `panelManager.ts`, `shared/types/panels.ts` | [TOOL_PANEL_SYSTEM.md](TOOL_PANEL_SYSTEM.md) |
| Renderer updates | IPC events in `main/src/events.ts` | [STATE_MANAGEMENT.md](STATE_MANAGEMENT.md) |
| Timestamps | `main/src/utils/timestampUtils.ts` | [TIMESTAMP_HANDLING.md](TIMESTAMP_HANDLING.md) |
| Pane Chat and orchestration sessions | `paneChatManager.ts`, `skillCacheManager.ts`, `paneChatBundle/` | [SESSIONS.md](SESSIONS.md) |
| Loops (scheduled tasks) | `main/src/services/loops/`, `main/src/ipc/loops.ts`, `shared/types/loop.ts` | [LOOPS.md](LOOPS.md) |
| SSH hosts view | `sshConfigHosts.ts`, `ipc/sshHosts.ts`, `SshView.tsx` | [SSH_HOSTS.md](SSH_HOSTS.md) |
| `runpane` CLI contract | `contracts/runpane/` | [RUNPANE_CLI_CONTRACT.md](RUNPANE_CLI_CONTRACT.md) |
| Analytics | `analyticsManager.ts`, `frontend/src/services/posthog.ts` | [ANALYTICS_INVARIANTS.md](ANALYTICS_INVARIANTS.md) |
| Themes | `frontend/src/styles/tokens/colors.css` | [APPEARANCE.md](APPEARANCE.md), [scripts/README.md](../scripts/README.md) |
| Usage and cost | `main/src/services/usage/` | [usage/README.md](../main/src/services/usage/README.md) |
| Mobile companion | `mobile/` | [NATIVE_MOBILE.md](NATIVE_MOBILE.md) |

## Rules that follow from this design

- Run project commands through the asynchronous `CommandRunner` and
  `CommandExecutor` (`main/src/utils/`). Await results through IPC and the
  lifecycle callers, drop results from stopped or replaced watchers, and
  serialize Spotlight checkouts with restoration.
- For git status in WSL, watch from inside the distro: prefer `inotifywait`.
  Without it, Pane polls `git status` in the distro every five seconds while
  focused. Don't add Windows-side recursive watchers over `\\wsl.localhost` or
  `\\wsl$`.
- Production builds must never include React Scan (`pnpm perf:scan` is dev
  only).

### Agent Chat

[Agent Chat](AGENT_CHAT.md) connects agent tabs to host-owned Claude ACP or native
Codex app-server runtimes. The same panel keeps a durable conversation identity
and generation across interfaces, using provider-native history forks when exact
transfer is unavailable. Codex views can share one running provider owner. Desktop and remote
viewers share the command registry and ordered projection events; viewer lifetime
does not control the agent process. See the compatibility and recovery limits in
the linked guide.
