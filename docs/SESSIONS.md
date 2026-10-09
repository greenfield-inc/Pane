# Sessions

Sessions are named, ongoing Pane Chats where work intent lives. Each Session
opens one chat, and its sidebar row can expand to show associated Panes. The
optional overview keeps the Session name, associated Panes, and recent
activity together while the chat remains the focused work surface. A tab
shares its parent Pane's worktree.

In the sidebar, `+` opens an agent picker, an optional Session name field, and
an optional "What is this Session for?" field that becomes the Session's goal.
Pane remembers the chosen agent as the default for future Sessions while
existing Sessions keep their own agent. A blank name starts as `New chat` or
`New chat 2` and is renamed once from the first message you send the Session
agent; a name you type or set later is kept. Each new Session opens as one Pane
Chat and can be renamed later from the optional read-only overview. Expand a Session to see
its associated Panes and open any Pane in its existing sidebar view.

The Sessions section below the divider can be collapsed from its header; the
`+` remains available while it is collapsed. Sessions are opened from this
section rather than from a duplicate top navigation shortcut.

A Session is a persistent coordination conversation with its own scratch
workspace. Its default profile supports discussion, investigation, decisions,
and delegation when authorized work benefits from it. No particular skill,
ticket system, model, or Agent Farm installation is required. Users can select
skills and workflows without Pane imposing an implementation pipeline.

## Upgrading from Pane Chat

Existing Pane Chat opens under Sessions automatically, keeping its name and all
agent conversations together. Switching agents resumes that agent's existing
panel and history in the same stable private Session workspace. Opening the
Session does not submit a prompt or authorize new work.

Earlier development versions split old agent histories into supplemental
Sessions. Untouched imports with only generated workspace files and no competing
conversation are reunited with the original Session. Imports with files, settings changes, or
additional conversations remain separate to preserve that work. Those retained
Sessions receive independent internal owners while keeping their names, folders,
panel IDs, saved histories, and settings. Interrupted ownership moves resume on
startup; no transcript or workspace files are deleted by this migration.

## Launch configuration and profile

Sessions use the same built-in launch presets and saved custom commands as
ordinary project/worktree panels, including custom arguments. The application
default seeds new Sessions. Creating a Session remembers its launch command and
arguments for the next creation; cancelling leaves that default unchanged.
Selecting the agent default clears the remembered custom command. Each Session saves its own launch configuration
and behavior profile. Changing defaults does not overwrite existing Sessions.
Launch changes take effect on the next explicit restart.
Use **Edit behavior…** during creation or in Session settings to open the
separate profile editor. **Back** discards the draft; **Save behavior** applies it
to the form, which is persisted when you create the Session or save settings.

The command, behavior profile, and saved task context have separate purposes.
A command selects how the agent runs; a profile describes how it should behave;
saved goals, decisions, and next actions help it respond to later user input.
Custom commands (including Agent Farm wrappers) retain their arguments. Pane
only adds native flags through compatible built-in adapters unless you explicitly
configure custom command resume. Wrappers keep control of instruction discovery;
Pane does not infer native flags from a wrapper name. A user command
that explicitly starts work remains the user's choice.

Each Session owns a stable folder at `<PANE_DIR>/sessions/<session-id>/` for
notes, plans, attachments, generated instructions, and artifacts. Renaming,
reopening, and archiving retain this folder. These folders are not Git
worktrees or security sandboxes and do not expire with OS temporary files.
Project implementation belongs in an appropriate Pane/worktree.

## Windows and WSL runtimes

On Windows, **Create Session → Run agent in** appears directly below the agent
picker when WSL reports installed distributions. Windows is the default on every
creation. Choose a named distribution to run the agent there; install the agent
inside that distribution first. Cursor is available when WSL is selected.
The runtime and distribution belong to the Session and survive reopening,
application restart, and terminal supervisor restart. Existing records retain
their host runtime through an additive store migration.
If creation fails before publishing a terminal owner, Pane removes untouched
generated files so the name can be retried; user files or edits prevent rollback.

WSL Sessions retain their durable files under the Windows Pane data directory.
Their agent sees Linux paths such as `/mnt/c/Users/.../.pane/sessions/...`.
This uses Pane's existing Windows-to-WSL path conversion and requires the default
`/mnt/<drive>` automount layout; custom `[automount] root` settings are not supported.
Generated `AGENTS.md` points to a Session-specific `runtime-context.md`; this
context takes precedence over the shared Pane Chat routing instructions.

Each WSL Session gets a managed `.pane-runtime/runpane` wrapper on PATH, also
available as `$PANE_RUNPANE_BIN`. It invokes this build's bundled Windows CLI via
PowerShell interop from Windows TEMP, so the CLI can reach this Pane instance's
named pipe. Arguments cross as JSON to preserve quotes and Unicode. Temporary
files beside the bridge carry payloads without Windows command-line size limits
and are removed when the call exits; stdin remains available to the CLI. File flags
accept relative or absolute Linux paths (including `--flag=value`); `-` retains
stdin semantics. `--repo` translates absolute Linux paths and explicit relative
paths (`.`, `..`, `./...`, `../...`) while preserving repository names and IDs.
Paths inside JSON request bodies must use Windows paths, and
Windows paths returned by the CLI can be read in WSL after `wslpath -u` conversion.
The bridge pins `--pane-dir` to this instance and preserves the calling Session
and panel identities. PowerShell is invoked by its mounted Windows path, so
`appendWindowsPath=false` is supported. WSL interop must be enabled; a Linux-installed RunPane CLI
cannot replace this bridge for a Windows daemon.

For CLI JSON creation, `runtime: "wsl"` and `wslDistribution: "Ubuntu-24.04"`
select an installed distribution; omitted runtime selects the host.

## Resuming custom launchers

Use **Enable custom command resume** in Session launch settings or a saved custom
command's editor. This is an explicit contract, independent of executable names.
Choose a session ID source and provide first-launch and resume templates:

- **Claude:** Pane allocates a UUID and resumes it only when its transcript exists.
- **Codex / Cursor:** Pane captures the native resume ID from terminal output.
- **Pane allocates an ID:** for other CLIs that accept a caller-provided ID.
- **CLI reports its ID:** the CLI or wrapper prints a standalone newline-terminated
  `PANE_AGENT_SESSION_ID=your-session-id` line. IDs may contain letters, digits,
  periods, underscores, colons, and hyphens (up to 256 characters).

`{command}` expands to the saved command; `{sessionId}` expands to the quoted ID.
Leave the ID placeholder unquoted. For a launcher that forwards native arguments
through `--`, Claude templates could be `{command} -- --session-id {sessionId}`
and `{command} -- --resume {sessionId}`. Codex could use `{command}` initially
and `{command} -- resume {sessionId}` on resume. These are user configuration
examples, not automatic wrapper detection. Other CLIs can use other syntax.

The configuration and ID persist with the panel. Without a captured ID, Pane
uses the first-launch template instead of guessing a latest conversation. Saved
custom commands copy their resume settings into new panels; changing the saved
shortcut does not change existing panels. Session settings support changing or
disabling the contract for that Session's next launch. No prompt is submitted just
to resume. Old conversations whose IDs were never saved cannot be recovered
automatically; use an explicit resume command if you know their ID.

## Session sidebar and archive

Pinned is the first sidebar category and can contain both Session chats and
Panes. Right-click a Session, or use the ⋯ button that appears on hover, to pin or unpin it, or turn on **Start pinned** in
Create Session to pin it from the start. The dialog remembers that toggle for
the next Session (on the desktop in Pane's config, in the remote web app on
that device). The pin preference survives restarts; an archived Session stays
out of Pinned until it is restored. RunPane can set the same preference with
`sessions pin` or `sessions unpin --session <id|name>`. Create JSON accepts
`isPinned` (default false), and update JSON accepts it without changing the
preference when omitted.

Click a Session row to open its chat, or use **Switch to Session: <name>** in the
command palette (`⌘⇧P` / `Ctrl+Shift+P`), which also has **New Session**. A Session with associated Panes shows a
chevron that expands or collapses them; a Session without Panes shows none.
Child Pane rows are indented beyond the Session chat icon and keep the ordinary
Pane actions. Create Pane, opened while a Session is showing, has an
**Add to <Session>** checkbox, on by default, that files the new Pane under that
Session. A Pane that belongs to a Session names it in the window title bar as
"<Session> › <Pane>"; click the Session name to go back to it. To file an
existing Pane under a Session, right-click the Pane, choose
**Add to Session**, then pick the Session. **Remove from <Session>** in the same
menu takes it out again; the Pane and its worktree are unchanged. Pinned Pane
rows show the Pane name with its repository muted beside it. Single-line Pane rows omit change counts and PR numbers; the
optional two-row layout shows those details below the title. Session and Pane
context menus use compact widths.

The experimental **Attention inbox** (Settings > Advanced > Experimental) turns
the Projects list into an Inbox of the Panes that need you: an agent waiting on
input or approval, an agent that completed a real turn since Pane started (it
worked on a prompt and went idle; a freshly started agent does not count), or a
Pane that errored. Session child rows follow the same filter, and a Session row still
counts all of its Panes. A row leaves when its agent works again; opening it
does not remove it. Hover a row and choose **Dismiss** (check mark) to hide it
until its agent works again. The row under the Inbox counts the hidden Panes
("3 running · 1 idle") and **Show all** lists every Pane. Pinned rows are
unchanged, and ⌘1–9 number the Inbox rows while it is shown.

The right sidebar has Overview, Files, and Changes tabs. Overview shows the
Session's blockers, goal, next step, and decisions when they are set, then its
Panes and recent activity. Agent state changes stay out of Activity; the status
dot shows them. Files browses the Session workspace. Changes summarizes the
Session's Panes and opens a Pane for detailed review. The upper-right sidebar
button shows or hides the selected tab. A single Session uses two rows at the
top: the window title bar shows its name and controls, and the tab strip sits
directly below it. Session file clicks open editor tabs beside the agent tab in
that strip. These tabs can be selected and closed directly, and reopening a file
restores its tab.

![Two-row Session header in Folio](screenshots/two-row-header-folio.png)

![Two-row Session header in Walnut](screenshots/two-row-header-walnut.png)

Right-click a Session, or use its ⋯ button, to archive it. An "Archived · Undo"
toast offers to restore it for a few seconds, and archiving the open Session
returns the desktop view to Home. Archiving hides the chat from the active
Sessions list while retaining its identity, conversation history, and Pane
associations. Its Panes and worktrees remain accessible through repository
navigation. Restore the Session from the sidebar’s Archived section. This is
separate from archiving a project Pane and does not delete delegated work.

The existing Session update contract accepts `archived: true` or
`archived: false`. List results retain archived records; active navigation
filters them. Archiving the selected Session chooses an available active
Session or clears the selection if none remain. Restoring a Session does not
replace an unrelated selection.

## Session startup

Creating, opening, restoring, restarting, or switching the agent in a Session
does not submit a bootstrap message. The terminal waits for user input with
its role, profile, and Pane capability instructions available. There is no
automatic greeting, diagnostic sweep, watcher setup, or continuation of a
saved next action. Reopening an already-running Session reconnects without
interrupting work the user has already authorized.

Pane may prepare instruction files and terminal infrastructure at startup;
that preparation does not require an agent turn. Unattended work and watchers
are separate, explicitly authorized activities.

## Shared tools and authority

Session orchestrators and regular agent panels share RunPane's coordination
capabilities. Use `runpane doctor --json` and `runpane agent-context --json`
when the task requires those capabilities, and discover individual schemas
with `runpane agent-context --command "<command>" --json`.

An associated worker completes its assignment and reports results or blockers
to its owning Session. Reporting is participation. Creating workers, assigning
work, redirecting agents, or changing ownership requires a user request or an
explicitly delegated task with that authority. Existing authorization persists
within its scope. An independent Pane works locally unless coordination is
requested. Tool availability does not authorize unrelated work or automatic
sharing of other conversations.

## One Pane per feature

**1 feature = 1 worktree = 1 branch = 1 Pane.** Reviews, audits, fixes and QA for a feature happen in that Pane as tabs.

A Pane is a git worktree. Creating one checks out the repository, installs
dependencies and often builds, so it is expensive, and creating several at once
can freeze the machine. An orchestrator creates one Pane per feature, with
`runpane panes create`, and only for new, independent work on its own branch.

Every later agent for that feature runs inside its Pane as a new agent tab:
implementer, reviewer, follow-up reviewer, fix implementer and QA. Each tab is a
fresh agent with its own context, sharing the Pane's worktree and branch:

```text
runpane panels create --pane <feature-pane-id> --tool-command "<agent command>" --source agent --no-focus --wait-ready --yes --json
```

Never create a Pane to review, fix or QA work that already has one. Keep the
feature's Pane until its PR merges or closes, so later tabs still have the
worktree; archive it then.

## Pane association before delegation

Management is a Pane-level relationship; tabs inherit the relationship and
share the Pane's worktree. Panes the orchestrator creates or adopts with
`runpane panes create` or `panes adopt` are associated with its Session in the
same call: the CLI reads `PANE_ORCHESTRATION_SESSION_ID`, each result item
reports `association: { sessionId, ok, error? }`, and `--no-associate` opts
out. A failed association never undoes the new Pane. Before delegating to an
existing Pane, or when automatic association failed, the orchestrator
associates it explicitly. The supported command is:

```text
runpane sessions associate --session <id|name> --pane <pane-id> [--json] [--pane-dir <path>]
```

Verify the result with `runpane sessions overview` and reuse an existing
association. A Pane already managed by another Session is a conflict: do not
detach, reassign, or create a duplicate Pane. When a prompt is passed to `panes
create`, check the item's `association.ok` right away. Keep a Pane attached through idle and completion; do not detach on
completion. Archiving preserves the association.

To close out finished work, `runpane panes archive --session <id|name> --merged
[--remove-worktree] [--dry-run] --yes --json` archives every associated Pane
whose work is clean and pushed, or whose branch was merged through a pull
request whose head is the Pane's `HEAD`. Every other Pane is skipped with a
reason (`skipped.code`). `--remove-worktree` also removes adopted worktrees;
local branches are always kept. Run it with `--dry-run` first.

Before mutating, use `runpane agent-context --command 'sessions associate'
--json` to confirm the wrapper supports the command. If an older global CLI
does not, select and verify the app-compatible dev wrapper from the Pane
runtime context before proceeding. Never silently continue without the
association or substitute an unverified global/`npx` wrapper.

Sessions do not create worktrees and do not edit project implementation files.
An association identifies work that a Session coordinates; it does not grant
implementation authority by itself. Detach a Pane before assigning it to a
different Session.

## Stable interfaces

The shared record and service are:

- `shared/types/orchestrationSession.ts`
- `main/src/services/orchestrationSessionManager.ts`
- `orchestration-sessions.json` below `PANE_DIR`

The daemon and Electron IPC channels are:

`orchestration-sessions:list`, `orchestration-sessions:select`,
`orchestration-sessions:create`, `orchestration-sessions:get`,
`orchestration-sessions:update`, `orchestration-sessions:set-agent`,
`orchestration-sessions:associate`, `orchestration-sessions:detach`, and
`orchestration-sessions:overview`.

Selectors accept a stable Session ID or an exact Session name. The existing
`pane-chat:*` channels remain compatibility endpoints for the imported legacy
conversation.

RunPane exposes the corresponding commands:

```text
runpane sessions list --json
runpane sessions get --session <session-id-or-name> --json
runpane sessions overview --session <session-id-or-name> --json
runpane sessions create --from-json <path|-> --json
runpane sessions update --session <session-id-or-name> --from-json <path|-> --json
runpane sessions pin --session <session-id-or-name> --json
runpane sessions unpin --session <session-id-or-name> --json
runpane sessions set-agent --session <session-id-or-name> --agent <agent> --json
runpane sessions associate --session <session-id-or-name> --pane <pane-id> --json
runpane sessions detach --session <session-id-or-name> --pane <pane-id> --json
```

Use `--from-json` for structured create and update input. Keep multiline
context, evidence, links, and reports in the JSON file or stdin; do not put
external text into shell source. Re-read mutation results and inspect the
overview after associations or updates.

## Resume and refresh persisted context

When responding to a user task that needs Session state, read
`PANE_ORCHESTRATION_SESSION_ID` from the current environment. Pane exports this stable identity for
Session panels, including agent resume paths that do not receive the original
bootstrap input. Do not infer the Session from a terminal panel ID or from
conversation text.

When the variable is present and the task requires it, reload the saved record
and then reconcile live
Pane, tab, branch, and evidence state:

```text
runpane sessions get --session "$PANE_ORCHESTRATION_SESSION_ID" --json
runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json
```

Run `get` to recover persisted intent and associations, and run `overview`
when continuing a task after a resume or after a mutation. For workers, this variable does not identify a parent Session. Use `runpane
sessions list --json` and Pane associations to resolve ownership; never infer
it from the selected UI Session. Refresh associations before coordinating work. If the
stable ID cannot be resolved, report the error before taking Session-specific
actions.

## Identity and overview

Each orchestration Session has a stable ID, a hidden detached Pane session for
its conversation, and one deterministic terminal panel for each supported
agent. The imported legacy Pane Chat record retains its legacy internal IDs,
resume IDs, and terminal buffers. New Session records must not reuse those
identities.

Legacy Pane Chat keeps its agent histories together in one Session. Previously
split imports are reunited only when untouched; retained independent imports
receive separate hidden owners so their workspace tools cannot cross Sessions.

The overview joins persisted intent with fresh Pane, tab, branch, worktree,
agent, and available Git or pull request evidence. Working, idle, stopped,
exited, missing, and archived states describe activity or availability. They
do not prove completion. A completion report must carry inspectable evidence,
the report timestamp, and provenance; new activity makes an older report
stale.

## Named locks for shared resources

When several workers share one resource that only one of them may use at a
time, such as a test account whose "approve guest" banner any logged-in worker
can click, name a lock in their prompts. Each worker takes the lock before it
uses the resource and gives it back after:

```text
runpane lock acquire --name testing-account --ttl 30m --wait 1800000 --note "call QA" --json
# ... use the shared account ...
runpane lock release --name testing-account --json
```

- **Owner.** The calling Pane and panel, from `PANE_SESSION_ID` and
  `PANE_PANEL_ID` (or explicit `--pane`/`--panel`). Outside a Pane terminal the
  owner is external and `--note` is required: it names the owner, so pass the
  same note to release.
- **Scope.** A lock is scoped to the owner's Session when its Pane belongs to
  one (as the Session's orchestrator or an associated Pane), so two Sessions can
  each hold `testing-account`. A Pane outside any Session uses the global scope.
  The scope is fixed when the lock is first taken.
- **Acquire.** Succeeds when the lock is free, expired, or already held by the
  same owner, which renews the TTL (`renewed: true`). Otherwise it returns
  `ok: false` with `heldBy` and `expiresAt` and exits 1. With `--wait` the call
  blocks in the daemon, which grants the lock to the oldest waiter as soon as it
  is released or expires; the CLI chains daemon calls of up to 120 seconds for
  longer waits.
- **Release.** Only the owner can release a lock. `--force` releases another
  owner's lock, for example a stuck worker's; add `--session <id|name>` to
  name a Session-scoped lock from outside that Session.
- **Automatic release.** Pane releases a lock when its TTL (at most 24h) runs
  out, when the owner panel's terminal exits or is closed, and when the owner
  Pane is archived. Quitting Pane does not release locks: the resumed agents
  still expect to hold them.
- **Storage.** Locks are saved in `locks.json` below `PANE_DIR` with
  temp-and-rename writes, so they survive a daemon restart. Expired locks and
  locks whose owner Pane or panel is gone are dropped when the file loads.
- **Visibility.** `runpane lock list [--session <id|name>]` lists held locks,
  and `sessions overview` includes `locks`: those scoped to the Session plus
  those its Panes hold.

If a worker interrupts a waiting `lock acquire`, the daemon may still grant it
the lock for up to two minutes; release it, or let the TTL expire.

## Session watcher

When monitoring is authorized, use one durable, named watcher per Session. Do not start it merely because a Session opens. `--session` takes the Session ID
or exact name, and the daemon follows every Pane associated with it:

```text
runpane watch --session <session-id> --follow --quiet --json \
  --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone,pane.associated,pane.detached,pr.conflicted,pr.checks,pr.merged,agent.report \
  --settle 180000 --blocked-settle 30000 --min-interval 600000 \
  --idle-backoff
```

The daemon resolves the Session once per request and re-reads its
associations on every journal read. A Pane associated after the watcher
starts is included; a detached or archived Pane drops out, together with any
line still held for it by `--settle` or `--min-interval`. The Session's own
hidden owner and orchestrator panels never appear, and an association limited
to specific panels reports only those panels. There is no re-arm after
`sessions associate` or `sessions detach`. `--session` cannot be combined with
`--pane` or `--all-managed`, an unknown Session fails the watch, and a daemon
that predates `--session` fails it with `WATCH ERROR` instead of watching every
Pane.

Membership changes are journal entries: `pane.associated` (`JOINED <pane-name>
pane <pane-id> session <session-id>`) and `pane.detached` (`LEFT ...`). The
Session manager emits them from `sessions associate` (only when the Pane was
not already a member) and `sessions detach`. A watch without `--session`
receives them only when `--kinds` lists them, so older clients never see an
unknown kind. Cadence state is keyed by the Session rather than its current
Panes, so held lines survive membership changes.

PR events come from the daemon's Session PR monitor
(`main/src/services/sessionPrMonitor.ts`, decision D7). About every 3 minutes
(jittered) it visits each Pane associated with a Session that is not
archived. With no such Pane it runs no `gh` at all. A Pane whose PR is known to
be open gets `gh pr view <number> --json
number,url,state,mergeable,statusCheckRollup,headRefOid`. Any other member (no
cached PR because nobody has looked at it, or a closed or merged one) is first
looked up by branch with Pane's own `gh pr list --head <branch>` lookup, which
also updates the Pane's git status, so a background worker's new or reopened PR
is found within a round. All calls share the one-at-a-time `gh` slot Pane uses
for its own PR lookups, so a round costs at most two calls per member. It
appends, on transitions only:

- `pr.conflicted` (`PR <pane-name> pane <pane-id> #<number> CONFLICTED`): the
  PR now conflicts with its base. GitHub's transient `UNKNOWN` answer never
  counts as a change.
- `pr.checks` (`... CHECKS PASSED`, or `... CHECKS FAILED lint,test` with up to
  five names): every check on the head commit finished. A new head commit
  reports again once its checks finish.
- `pr.merged` (`... MERGED`). A merged PR is not polled again. A closed PR stops
  polling without an entry.

Entries carry `pr: {number, url, headOid}`, and `pr.checks` adds `checks` and
`failingChecks`. The first poll of a PR after the daemon starts only records
its state, so a restart never restates old conflicts; check `gh pr view` once
after a restart. `pr.conflicted` and failed `pr.checks` bypass
`--min-interval` like `BLOCKED`. The PR kinds are opt-in like `JOINED`/`LEFT`.
Without `gh`, or while it is signed out, rate limited, or timing out, the
monitor logs once, doubles its delay up to an hour, and resumes when `gh`
answers again.

The cursor defaults to `session-<uuid>`, where `<uuid>` is the UUID inside the
Session ID: the Session `__orchestration_session_<uuid>__` uses
`session-<uuid>`. Passing the name instead gives `session-<name>`. Cursor names
may be up to 128 characters (64 before this release); when runpane derives a
name itself, such as this default or the `PANE_PANEL_ID` fallback, it shortens
one longer than 64 characters (or one with other characters) to
`<prefix>-<first 12 hex characters of its sha256>`.

A discussion-only Session has no follow watcher. On restart, retain the
`session-<uuid>` cursor and capture a fresh output baseline before
interpreting notifications. After a reset (`_reset`), the baseline restates
current state: those JSON entries carry `replay: true` (and
`changedWhileAway: true` after a daemon restart). A replayed `agent.ready` is
never READY; re-read `sessions overview` instead of acting on it. Lines mode
prints only `CHANGED` for them. Return blocked and decision findings to the
Session conversation. Terminal idle or exit remains activity evidence only.

`--quiet` (alias `--no-control-lines`) drops the control lines that only prove
liveness: `_ok`, `_heartbeat`, and `_reconnected` (`WATCH OK`, `HEARTBEAT`,
and `WATCH RECONNECTED` in lines mode). `_error`, `_reset`, and `_dropped`
always print. Under `--follow`, JSON entries for a panel holding unsent
composer text carry `heldInputPresent: true`, the JSON form of `STUCK`.

### Watch profiles

| Profile | When | Flags | Worst-case READY delay |
|---|---|---|---|
| Unattended (default) | Overnight or background runs; every wake-up costs a full context replay | `--settle 180000 --blocked-settle 30000 --min-interval 600000 --idle-backoff` | about 13 minutes |
| User present | Someone is waiting on the result | `--settle 60000 --blocked-settle 15000 --min-interval 120000`, no `--idle-backoff` | about 3 minutes |

Both profiles use the same `--kinds` list, `--quiet`, and named cursor.
Switch profiles by stopping the previous monitor, then re-arming the same cursor. If a monitor reports that its cursor was superseded, keep the replacement and do not re-arm the old monitor.

## Worker reports

Workers hand back a structured report when they finish or get blocked. Every
worker prompt ends with:

```text
When finished or blocked, run
runpane report --state <ready|blocked|failed|done> --pr <number> --head <sha> --summary-file <path>
(add --question "<question>" when blocked).
```

Inside a Pane terminal `runpane report` finds its own panel through
`PANE_SESSION_ID` and `PANE_PANEL_ID`; elsewhere pass `--pane` and `--panel`.
`--question` is required with `--state blocked`, `--pr` is a positive integer,
and `--head` is 7 to 40 hex characters.

The daemon then:

- keeps the latest report in the panel's custom state, so it survives a
  restart: `{ state, pr, head, summary, summaryPath, question, reportedAt }`,
  with up to 16,000 characters of summary (a longer one ends with a truncation
  marker and sets `summaryTruncated`);
- journals an `agent.report` entry with the same fields (summary cut to 2,000
  characters), printed as `REPORT <pane-name> pane <pane-id> panel <panel-id>
  ready pr#747 fc5dce9` or `... blocked: <question>`. It skips the
  `--min-interval` batch. Only watchers that list `agent.report` in `--kinds`
  receive it, because released CLIs reject journal kinds they don't know;
- appends a `report` activity (with the worker's `paneId` and `panelId`) to
  every Session the Pane is associated with, which makes an older Session
  report stale;
- shows the report in `agents status`, `panels list`, and `sessions overview`,
  where `panes[].report` is the newest report among the Pane's panels, with its
  `panelId`.

The orchestrator treats REPORT as the completion signal. A READY without a
report means look, and maybe nudge: `runpane panels last-message --panel
<panel-id> --json` returns the agent's last reply from its Claude or Codex
transcript (never the screen; `transcript-unavailable` otherwise), and the
worker can be asked to run `runpane report`.

## Skill contract

`main/src/services/skillCacheManager.ts` installs the skills that ship in
`main/src/services/paneChatBundle/` into
`<PANE_DIR>/skills/pane-chat/skills/` and into the `.claude/skills/` and
`.codex/skills/` folders of the data directory. It also generates the
`pane-orchestrator` entry skill (plus a Cursor rule at
`.cursor/rules/pane-orchestrator.mdc`), the runtime context, and the helper
subagents in `.claude/agents/` and `.codex/agents/`. A manifest
(`skills/pane-chat/installed.json`) records what it installed and a hash of the
bundle: startup skips the install when the hash is unchanged, and later installs
replace only the recorded entries.

To change Pane Chat behavior, edit the bundle or `buildPaneOrchestratorSkill()`
in `skillCacheManager.ts`, then run `paneChatBundle.test.ts`.

Bundled workflow skills are available to Sessions and can be selected according
to the user's task. The installed manifest lets Pane refresh its own skill files
without replacing unrelated user skills.

`shared/types/sessionProfile.ts` defines the generic default profile and shared
capability context. Generated guides and agent instruction files use this
contract. The legacy shared Cursor rule is not always applied; Session-specific
instructions belong to the Session's working directory. User-selected profiles
and workflows determine behavior after the user supplies a task.

## Terminal and Files

Each Session has a collapsible **Terminal** dock and a **Files** button beside
its agent tabs. The shell and file browser use the Session's workspace folder.
Selecting a file opens an editor tab alongside the agent conversation. Panels
are saved with the Session and reused when you reopen the tools; switching
Sessions keeps their shells and files separate.

## Plans, pages, and split view

Agents show pages and files with `runpane panels open --file <path>` or
`--url <url>`. Files open in an editor tab with read-only previews for supported
formats; HTML opens as read-only source. Use `--url` with an HTTP, HTTPS or file
URL for an intentional live browser tab. By default the tab opens in split view:
the first one splits the stage to the right of the conversation, and later ones
join that side group as tabs.
`--tab` opens it as a plain tab instead. Reopening the same file or URL reuses
and reloads its tab. This works the same in Sessions and in project Panes.

Generated Session instructions ask the orchestrator to write plans, reports, and
other documents as self-contained HTML files in its Session folder and open them
with `--url` when rendered HTML is intended, or `--file` to inspect the source.
Opening a Session never submits a prompt or starts work just to write
a document.

While the stage is split, each group has its own tab strip, including the agent
tab in its group. For a single Session, the strips align directly below the
window title bar. Closing the last tab in the side group returns to a single
group. Layouts are saved with the Session.

## Tiling Sessions side by side

![Two Sessions tiled side by side, both streaming](screenshots/session-tiling.png)

Sessions tile with the same gesture as tabs, one level up. Drag a Session from
its sidebar row — or by its title row once tiled — onto another Session and drop
it against an edge to put the two beside each other; drop it in the middle to
show it in that slot instead. Edge bands are the outer quarter of the target,
as they are for tabs, and the layout nests as deeply as you take it: a row of
Sessions with one of them split into a column is an ordinary shape, not a
special case.

Both halves stay fully live. A tile that is not focused keeps its agent running
and its output streaming; nothing is throttled or suspended, so a Session you
are watching out of the corner of your eye is the same Session you were just
typing in. Each tile keeps its own tab splits, its own Terminal dock, its own
Files and Changes sidebar, and its own navigation.

The focused tile's Session is the selected one: its title row carries the focus
ring, and clicking a Session in the sidebar focuses its tile when it already has
one, or shows it in the focused tile when it does not. With one tile that is
exactly the old behaviour — switching Sessions replaces the view.

The `X` on a tile's title row stops tiling that Session; the Session itself,
its conversation and its panels are untouched, and the layout collapses back
around the space. The last tile has no close button, since a window with no
Session in it has nothing to show. The command palette carries the same actions
for the keyboard: focus the Session left, right, above or below, and stop tiling
the focused one.

A layout belongs to the host it was built on, like the remembered location it
sits beside: Session ids only mean anything on their own host, so switching
hosts loads that host's layout and every tile is revalidated against the
Sessions that still exist there. Archiving or deleting a tiled Session retires
its tile and collapses the split.

## Reaching Pane and delegating work

The generated Session instructions tell the orchestrator how to reach
`runpane` (PATH, then `$PANE_RUNPANE_BIN`, then the runtime context) and forbid
substituting plain git worktrees or built-in subagents for delegated work; if
`runpane` is unreachable the agent stops and reports it. Worktrees the
orchestrator creates or adopts with `runpane panes create` or `panes adopt`
become the Session's children in the same call.

Earlier development builds had an experimental progress view that rendered
`progress.html` in a fixed side panel. It never shipped; Pane deletes its old
`.pane-progress.json` switch and leaves any HTML files in place.

New worktrees launched from a Session default to unpinned. First association also
clears a worktree's previous pin, including an explicit `--pinned` creation pin,
so it appears as a Session child. Use `panes pin` manually afterward; repeated association does not undo that choice. Independent
worktree defaults and existing historical pins are unchanged.

### Generated instructions and Git

Session instructions and documents live under `<PANE_DIR>/sessions/<id>/`,
outside the project. While the Session agent shows its folder-trust prompt, a
banner across the top of the chat says the folder is Pane's own, holding the
Session's notes and no project code. Session terminals set `GIT_CEILING_DIRECTORIES` to
`<PANE_DIR>/sessions`, so git run in a Session folder never picks up a repository
above it, such as a home directory tracked as a dotfiles repo. Do not configure
PANE_DIR inside a project repository.

### Move an existing chat to a Session

Right-click a worktree and choose **Move chat to Session…**, then choose the chat
if it has multiple agent tabs. You can also use **Move chat to Session** in the top
bar of a selected Claude or Codex chat. Then enter a unique Session name, and choose **Move chat**. The agent must be idle
and have a saved conversation ID. Pane stops the old terminal before transferring
the existing panel and resumes the same conversation from a private Session
folder. No initial prompt is submitted. The original worktree becomes a child;
its branch, files, and uncommitted changes remain in place. Other tabs stay there.

Cursor and custom launch wrappers are not yet supported for promotion. Missing
history, conflicting ownership, and active work are rejected before transfer.
A durable Session record allows reopening to complete an interrupted transfer
without copying the conversation. Terminal, Files, and split view
capabilities are the same as for a newly created Session.

Promotion defaults to the worktree's current name.
