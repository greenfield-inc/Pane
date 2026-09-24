# Sessions

Sessions are named, ongoing Pane Chats where work intent lives. Each Session
opens one chat, and its sidebar row can expand to show associated Panes. The
optional overview keeps the Session name, associated Panes, and recent
activity together while the chat remains the focused work surface. A tab
shares its parent Pane's worktree.

In the sidebar, `+` opens an agent picker and an optional chat name field. Pane
remembers the chosen agent as the default for future Sessions while existing
Sessions keep their own agent. A blank name receives a generated name such as
`New chat` or `New chat 2`; each new Session opens as one Pane Chat and can be
renamed later from the optional read-only overview. Expand a Session to see
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
Panes. Right-click a Session to pin or unpin it. The pin preference survives
restarts; an archived Session stays out of Pinned until it is restored.

Only the selected sidebar location is highlighted: opening a child Pane does not also highlight its repository row, and opening an orchestrator chat clears Pane-row selection.

Click a Session name to open its chat. The left chevron always appears and
expands or collapses associated Panes without switching conversations. Empty
Sessions start collapsed and show “No child sessions” when expanded. Child
Pane rows are indented beneath the Session and keep ordinary Pane actions.
Single-line Pane rows show the title and status indicator without change counts
or PR numbers. The optional two-row layout shows those details below the title.
Session and Pane context menus use compact widths.

The right sidebar has Overview, Files, and Changes tabs. Overview shows linked
Panes and activity. Files browses the Session workspace. Changes summarizes
linked worktrees and opens a Pane for detailed review. The upper-right sidebar
button shows or hides the selected tab. The title strip can be dragged between
controls; its drag area leaves both sidebar toggle buttons clickable.

Right-click a Session to archive it. Archiving hides the chat from the active
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

## Pane association before delegation

Management is a Pane-level relationship; tabs inherit the relationship and
share the Pane's worktree. The orchestrator reads its own stable identity from
`PANE_ORCHESTRATION_SESSION_ID` and associates a Pane immediately after
creating it, or before delegating to an existing Pane. The supported command
is:

```text
runpane sessions associate --session <id|name> --pane <pane-id> [--json] [--pane-dir <path>]
```

Verify the result with `runpane sessions overview` and reuse an existing
association. A Pane already managed by another Session is a conflict: do not
detach, reassign, or create a duplicate Pane. Prefer creating a Pane without
an implementation prompt, associating and verifying it, then submitting the
prompt. Keep a Pane attached through idle and completion; do not detach on
completion. Archiving preserves the association.

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

## Session watcher

When monitoring is authorized, use one durable, named watcher per Session,
scoped to its associated Panes. Do not start it merely because a Session opens:

```text
runpane watch --as session-<session-id> --follow --pane <pane-id> \
  --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone \
  --settle 180000 --blocked-settle 30000 --min-interval 600000 \
  --idle-backoff --json
```

Repeat `--pane` for each associated Pane. A discussion-only Session has no
follow watcher; never omit `--pane` to watch all Panes. After an associate or
detach mutation, refresh `sessions overview` and re-arm the same cursor with
the current Pane set. On restart, retain the `session-<session-id>` cursor and
capture a fresh output baseline before interpreting notifications. Return
blocked and decision findings to the Session conversation. Terminal idle or
exit remains activity evidence only.

## Skill contract

`main/src/services/skillCacheManager.ts` installs the skills that ship in
`main/src/services/paneChatBundle/` once per run: into
`<PANE_DIR>/skills/pane-chat/skills/` and into the `.claude/skills/` and
`.codex/skills/` folders of the data directory. It also generates the
`pane-orchestrator` entry skill, the runtime context, and the helper subagents
in `.claude/agents/` and `.codex/agents/`. A manifest records what it
installed, so later installs replace only those entries.

Bundled workflow skills are available to Sessions and can be selected according
to the user's task. The installed manifest lets Pane refresh its own skill files
without replacing unrelated user skills.

`shared/types/sessionProfile.ts` defines the generic default profile and shared
capability context. Generated guides and agent instruction files use this
contract. The legacy shared Cursor rule is not always applied; Session-specific
instructions belong to the Session's working directory. User-selected profiles
and workflows determine behavior after the user supplies a task.

The sidebar’s **Archived** list separates **Sessions** from **Worktrees**.
Each section stays visible when empty; worktrees are grouped by repository.
Opening the list refreshes both collections.

## Terminal and Files

Each Session has a collapsible **Terminal** dock and a **Files** button beside
its agent tabs. The shell and file browser use the Session's workspace folder.
Selecting a file opens an editor tab alongside the agent conversation. Panels
are saved with the Session and reused when you reopen the tools; switching
Sessions keeps their shells and files separate.

## Experimental progress view

Enabled by default in **Settings → Advanced → Session progress view (Experimental)**.
When an agent writes `progress.html` in its Session folder, Pane opens a resizable
split beside the conversation, initially dividing the main area equally, and
refreshes it during work. The icon-only Progress button independently hides or shows the
brief. Files stays in its own resizable right sidebar, controlled by the top-bar
sidebar toggle; both views can be open together. Session Settings and Progress
sit as icon buttons on the right side of the top tab bar, with tooltips.
The agent badge does not appear in the Session toolbar. Documents support self-contained HTML,
inline CSS/SVG and data images, without scripts, navigation or network requests.

Generated Session instructions ask the agent to update progress after meaningful
changes and before yielding, and to check `.pane-progress.json` before each update.
Disabling the setting hides the view, stops refreshes and removes the maintenance
instruction; existing HTML remains. Running agents may retain prior instructions
until their next normal context reload. Opening a Session never submits a prompt
or starts work just to create a progress page.

New worktrees launched from a Session default to unpinned. First association also
clears a worktree's previous pin so it appears as a Session child. You can pin it
manually afterward; repeated association does not undo that choice. Independent
worktree defaults and existing historical pins are unchanged.

### Generated instructions and Git

Session instructions and progress pages live under `<PANE_DIR>/sessions/<id>/`,
outside the project. Pane refuses to generate Session files when that directory
is inside a Git worktree, including through a symlink. Do not configure PANE_DIR
inside a repository.

Pane no longer publishes instructions into project AGENTS.md or CLAUDE.md.
Repository activation and agent launch remove only paired `pane-agent-context`
blocks left by older versions, preserving user text and imports. Existing empty
files are retained. This cleanup does not rewrite commits or unstage files: review
already-staged changes normally. Ordinary agents can retrieve command guidance
with `runpane agent-context --json`; Sessions load their private instructions.

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
without copying the conversation. Terminal, Files, and experimental progress
capabilities are the same as for a newly created Session.

Promotion defaults to the worktree's current name. Rename an existing Session
with **Rename Session…** in its right-click menu, or from its overview. Renaming
keeps the same Session ID, conversation, private folder, and child associations.

Worktree rows also offer **Rename worktree…**. This changes their displayed Pane
name; it leaves the Git branch, directory path, files, and conversations in place.
