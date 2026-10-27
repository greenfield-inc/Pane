---
name: migrate-to-pane
description: Bring the agent sessions a person already has (Claude Code, Codex, OpenCode, Cursor, Conductor, or any similar tool) into Pane, each opened in a Pane tab with its own agent's resume, verified, and reported. Use for "migrate to Pane", "bring my sessions into Pane", "import my Claude/Codex/Cursor chats", or after the person says yes to Pane's first-run offer.
---

# Migrate to Pane

The person wants their work, exactly as it was: every conversation they have
going in other agent tools, opened in Pane, picking up where it left off. The
same native session, resumed by its own agent, in the same checkout when
possible. Not a summary, not a fresh agent told what happened.

It works with any agent tool that keeps resumable sessions. Claude Code, Codex,
OpenCode, the Cursor agent and Conductor are the common ones; if you find
another, treat it the same way.

The bar is the [continuity check](references/continuity.md). Read it before you
start. A session is reported as continued only when it passes.

## Ground rules

- **Never disturb live work.** Never write to, append to, stop, or send input
  to an original session that is running elsewhere. Never delete, archive or
  close anything in another tool's store. Writing new files into a tool's store
  (a fork, or a session moved for a new folder) is allowed.
- **Learn on throwaways, never on the person's sessions.** To find out how a
  tool resumes or forks, read its docs and `--help`. If you must try a command,
  try it on a throwaway session you create for that purpose and then remove.
  Never resume, fork, prompt or open one of the person's sessions to see what
  happens, and never touch a session before the person has confirmed the list.
- **Two agents never edit one folder.** A session still running elsewhere is
  forked into a worktree of its own. When you can't tell whether a session is
  still running, treat it as running: a wrong guess then costs a worktree, never
  two agents in one checkout.
- **One copy of each id per store.** Never leave two copies of one session id in
  one tool's store on one machine; some agents then can't find it.
- **The person's checkout stays theirs.** Adopted checkouts are never removed:
  never pass `--remove-worktree` when archiving a Pane this skill created.
- **Prefer each tool's own features.** Resume and fork with the tool's own
  commands. Edit store files only when the tool has no command for it.
- **Report failures; don't paper over them.** A session that can't be continued
  is reported as not continued with the reason and the next step, never
  replaced by a fresh agent.

## What you already know

The Pane data directory is in your runtime context (`runtime-context.md`). Pass
it as `--pane-dir` to every `runpane` command, as the runtime context says.

Keep a migration record at `<Pane data directory>/migrate-to-pane/record.json`,
one entry per session you placed:

```json
{ "sessions": [ { "tool": "codex", "id": "<source id>", "folder": "<source checkout>",
  "paneId": "<pane>", "panelId": "<tab>", "forkId": "<fork id, or null>",
  "result": "continued | continued as a fork | not continued", "at": "<ISO time>" } ] }
```

Read it at the start of every run. A session whose `tool` and `id` are in it
with any result other than "not continued" is "already in Pane", forks
included, so a rerun creates nothing twice; a "not continued" one can be tried
again. Pane's "Bring your sessions into Pane" card brings idle sessions in and
writes this same record, with `tool` set to the agent, a `source` naming the
tool, and `result: "pending"` for a tab that was still starting or waiting at
its trust prompt.

## Keep it fast

A run should feel like a few minutes, not half an hour. Almost all of the time
is waiting on agents to start, so never wait on one session at a time:

- **Discover in one pass.** One metadata script per tool (ids, folders,
  branches, times, titles, running or not), not a command per session. Read a
  tool's `--help` once, only for what you don't already know.
- **Start everything, then wait once.** Register all repositories, then start
  every adopt, tab and fork Pane without `--wait-ready`, back to back. Run
  independent commands concurrently in the shell (`cmd & cmd & wait`), and
  create several fork Panes in one `runpane panes create --from-json`.
- **Fork in parallel.** Start all forks at the same time; each one is a short
  agent turn.
- **Check all tabs together.** Wait for every tab at once (one background
  `runpane panels wait --panel <id> --for ready` per tab, then `wait`), read
  every screen in one pass, and probe only the tabs whose history is unclear,
  all probes at once. When a wait reports a first-run dialog (a trust prompt,
  for example), answer it with the command it suggests and keep going.

Pane sets up each new worktree Pane through its setup queue, two at a time, so
a repository with a slow setup script bounds how fast fork Panes can start.
Adopted checkouts need no setup.

## 1. Find the sessions

The person said yes, so start; don't ask for permission to read other tools'
files.

- Find every agent tool in use on this machine: the tools' own stores in the
  home folder, tools inside each WSL distro Pane knows (on Windows), Conductor
  workspaces, and agents running right now in other terminals, VS Code, or any
  editor (the process list, and each tool's own live-session records). Work out
  where each tool keeps its sessions, and how it resumes and forks them, from
  that tool's own docs, `--help` and files. These formats are internal and
  change, so look rather than remember.
- **Read metadata first**: ids, folders, branches, times, titles. Don't read
  whole transcripts to build the list; open a transcript only to verify a
  session the person chose.
- For each session, work out whether it is running now, its git checkout
  (repository root, branch, whether it is a linked worktree), and when it was
  last active.
- Leave out your own session (this Pane Chat). Mark as **already in Pane** every
  session a Pane tab already runs (`resumeId` in `runpane panels list --pane
  <id> --json` for each Pane in `runpane panes list --json`, or a launch command
  naming its id) and every session the migration record holds in Pane (any
  result other than "not continued").

## 2. Show the list and confirm

Show one list, grouped by repository. For each session: tool, title, branch,
last active, and "running" when it is. Preselect sessions that are running or
were active in the last 7 days. List older ones unselected, so the person can
add them. Show "already in Pane" ones without a way to select them, and list
sessions with no folder or outside any git repository so they can be reported.

Create nothing until the person confirms the selection: no repos, Panes,
tabs, forks or trial runs, and no change of any kind to a session's files.

## 3. Place each chosen session

Register each repository once with `runpane repos add --path <repo root>`
(skip it when `runpane repos list --json` already has it). Then, per checkout:

- **Idle session, checkout is the repository's main checkout or one of its
  worktrees**: adopt the checkout in place. The first session in a checkout
  opens with `runpane panes adopt --repo <repo> --path <checkout> --name <name>
  --agent <agent> --resume <id> --launch` (OpenCode: `--tool-command "opencode"`
  with `--resume <ses_ id>`). Each later session in the same checkout becomes
  another tab in that same Pane: `runpane panels create --pane <id>
  --tool-command "<the agent's own resume-by-id command>" --agent <agent>
  --yes`. Pane runs that command unchanged and runs it again after a restart.
  Same folder, so nothing in the session needs rewriting.
- **Idle session in a clone that isn't a worktree of a registered repository**:
  register that clone as its own repository, then adopt it in place.
- **Idle session that can't be adopted in place** (for example a detached copy of
  a repository already registered from elsewhere): move the session so its
  agent finds it from the new folder, leaving one copy of its id in the store,
  then create a new Pane on the session's branch the same way as a fork below,
  resuming the session's own id, and carry the uncommitted and untracked files
  across. It gets the "moved" message.
- **Running session** (or not sure): fork it first, with the tool's own fork, so
  the fork has its own id and the original is untouched. Some forks append to
  the original (a fork command run inside the original chat, for example), so
  pick one that doesn't. Then create a new Pane on a new branch from the
  session's current commit, with the fork's resume as its tab: `runpane panes
  create --repo <repo> --name <name> --branch <new branch> --base <commit>
  --tool-command "<the agent's own resume-by-id command for the fork>"`. The
  resumed agent waits for input, so next copy the checkout's uncommitted and
  untracked files into the new worktree until `git status` and the file
  contents match the source. The original keeps running in its own
  checkout. Cursor has no fork command, and a copy of a Cursor chat still
  writes to the original chat once it is used, so a running Cursor session
  has no such fork. When a tool has no fork that leaves the
  original untouched, don't fork: report the session as not continued
  ("still running elsewhere; close it there and say 'migrate to Pane' again").
  Record each original's size, sha256 and modification time before you fork
  it, and compare them once the fork's tab is open: check 4 of the continuity
  check.
  A fork with no turn of its own can lead its tool back to the original when
  it is opened (an empty Codex fork, for example, made the tool write to the
  original's file), so prefer a fork that carries one short turn of its own.
- **Several sessions in one checkout** become tabs in one Pane, each resumed by
  its own id.
- **No folder, or outside any git repository**: create nothing for it; report it
  as not continued, with why and what the person can do.

Run the fork command first and read the fork's id from its output or store; only
then run the command that opens the fork's Pane, so the tab resumes that id.
Write each session to the migration record as soon as its tab exists.

## 4. Check, then report

Run the [continuity check](references/continuity.md) on every tab you opened,
send any "moved" messages after it passes, and keep going when one session
fails: the rest of the run still completes.

Finish with one report, grouped by repository: each session as **continued**,
**continued as a fork**, or **not continued**, with its Pane and tab, and for
anything not continued, what happened, why, and the next step. Mention the
sessions you left unselected and how to bring them in later: say "migrate to
Pane" again.
