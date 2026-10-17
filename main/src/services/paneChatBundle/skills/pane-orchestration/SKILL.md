---
name: pane-orchestration
description: How any orchestrator drives worker agents through Pane with the runpane CLI - one Pane per feature, launching a worker as a new Pane or tab (built-in agents or a wrapper --tool-command such as agent-farm run), the one wait primitive, worker reports and status files, answering workers, resuming after a restart or sleep, showing pages beside the person, shared-checkout and port etiquette, handoff and cleanup. Use when you start, wait on, answer, or recover workers in Pane, from a Pane Session or any other harness.
---

# Orchestrating workers in Pane

This is Pane's one guide to the mechanics of driving workers. It holds for any
orchestrator in any harness: a Pane Session, a Claude Code or Codex session in
a Pane terminal, or a wrapper such as Agent Farm.

Read it from anywhere with `runpane docs read --doc skills/pane-orchestration/SKILL.md`.
For a command's exact flags and result shape, run
`runpane agent-context --command "<command>" --json`.

## Who owns what

Pane is the transport: workspaces, terminals, input delivery, events, resume.
Your protocol (roles, routing, the status-file schema, question and decision
IDs, approvals, review policy) stays yours; Pane carries it and never parses
it. Where this guide and your protocol both speak, Pane wins on a mechanic and
your protocol wins on roles, approvals and review.

Before the first command: `runpane` must be on `PATH` (or use
`npx --yes runpane@latest` in its place), and `runpane doctor --json` must
pass. If it fails, stop and say what failed; don't fall back to raw
`git worktree` checkouts for work that belongs in a Pane.

## The loop

1. Write the worker's starting message (its brief) to a file.
2. Launch the worker in the feature's Pane, delivering that file.
3. Wait with the one wait primitive. It exits when something happens.
4. On wake, read the worker's report and its status file, then act: answer
   it, relay a question to the person, start the next worker, or resume one.
5. Wait again.

## One Pane per feature

**1 feature = 1 worktree = 1 branch = 1 Pane; every other agent for it
(implementer, reviewer, follow-up reviewer, QA, fixer) is a tab in that Pane.**
A new Pane creates a worktree that checks out, installs and often builds, so
create one only when the work's branch has none. Split work across Panes only
for independent packages, each with its own branch.

Find a feature's Pane before creating one: your own records first, then
`runpane panes list --repo <repo> --json`, matching the branch (for a PR,
`gh pr view <n> --json headRefName`) against
`git -C <worktreePath> branch --show-current`. `panes create --branch <name>`
refuses a branch another Pane has checked out (`ERR_RUNPANE_BRANCH_HAS_PANE`,
naming that Pane).

## Launch a worker

The feature's first worker creates its Pane; every later worker is a new tab:

```sh
# first worker: a new Pane (and worktree)
runpane panes create --repo <repo> --name <slug> [--base <ref>] [--branch <name>] \
  --agent <claude|codex> --tool-command "<agent command>" \
  --initial-input-file <brief file> --as-file-pointer \
  --source agent --no-focus --wait-ready --yes --json

# later workers: a tab in the feature's Pane
runpane panels create --pane <feature pane id> --title <role> \
  --agent <claude|codex> --tool-command "<agent command>" \
  --initial-input-file <brief file> --as-file-pointer \
  --source agent --no-focus --wait-ready --yes --json
```

- **Built-in agents:** leave out `--tool-command`; `--agent` picks Pane's template.
- **Wrappers:** `--tool-command` runs any launcher unchanged, for example
  `"agent-farm run <profile>:<variant> --arg parent=<absolute status file> --arg source=<absolute source>"`.
  Pass `--agent` with the agent the wrapper runs, so Pane treats the tab as
  that agent from the start: readiness, delivery checks, BLOCKED and EXIT
  events, resume. Put every choice on the command line. A wrapper that asks
  before it starts the agent (Agent Farm's variant picker when the command
  names no variant, its workspace-trust question) holds the tab. Pane reports
  that as BLOCKED, and reports BUSY and READY, even before it has identified
  the agent behind the wrapper.
- **The brief:** `--as-file-pointer` copies the file into the worker's own
  worktree, at `.pane/prompts/<timestamp>.md` (Pane adds `/.pane/prompts/` to
  the repository's `.git/info/exclude`, so it is never committed), and types
  the single line `Read and follow .pane/prompts/<file>.md` into the agent's
  input box, so a long brief never passes through the shell or the terminal.
  The path in that line is relative to the worktree, where the agent starts;
  the result's `promptFile` is absolute. Pane does not read the brief: check it
  has every field your protocol requires before you launch. Use absolute paths
  in it for sources, the status file, and any skill to follow (a worker in
  another repository has none of your skills installed).
- **Files the worker needs go with the brief.** Add `--attach <file>`
  (repeatable, with `--as-file-pointer`) to copy mockups, plans or dispatch
  notes beside the brief; the pointer line lists the copies. A worker whose
  harness refuses reads outside its working directory (Claude Code with
  `permissions.blockReadsOutsideWorkingDirectories`, or a sandbox) can read
  both without a prompt. A worker in a Session's Pane also gets the Session
  folder as `PANE_SESSION_DIR` (read-only for built-in Claude Code); write its
  absolute path into the brief rather than the variable. Details, including
  what each agent gets, are in `docs/SESSIONS.md`, section "Worker file
  access".
- **Without a local git worktree** (a folder that isn't the top of a checkout,
  or a WSL repo), the brief goes to `<pane-dir>/prompts/` with an absolute
  pointer, outside the worker's working directory. Such a worker can stop on
  "Read outside the working directories" and wake you with BLOCKED; send a
  short brief inline instead (drop `--as-file-pointer`, and Pane sends the
  file's text itself).
- **`--wait-ready`** waits until the agent's input box is on screen (up to
  `--ready-timeout-ms`, default 30000; give a wrapper 180000), types the line,
  and checks the agent took it. It never types into a shell, a wrapper's own
  prompt, or a trust or permission menu.

### Read the result once

The result is JSON (`panes create` puts each Pane under `items[]`). Check, in
this order:

| What the result says | Means | Do |
| --- | --- | --- |
| `ok: true`, `initialInput.delivery.state` `taken` | the agent started a turn with the brief | record it (below) and wait |
| `ok: true`, state `queued` | the agent was busy and runs it after its current turn | the same; never resend |
| `readiness.blocked`, kind `codex-update` | Codex shows "Update available" instead of its input box | run `readiness.blocked.suggestedCommand` (it skips the update) |
| `readiness.blocked`, kind `first-run-dialog` or `agent-prompt` | a trust, permission or picker screen; `message` quotes it | the person's call: show them `message`, answer only as they say |
| `readiness.reason.code` `command-exited` or `no-agent-detected` | the launcher exited, or no agent appeared | read `runpane panels screen --panel <id> --json` once; fix the command; nothing was typed |
| `initialInput.delivery.state` `in-composer` | the line is still in the input box | `runpane panels submit-composer --panel <id> --strategy auto --yes --json` once |
| `initialInput.blocked.kind` `submission_unverified`, or state `unknown` | Pane could not prove delivery | don't resend: read `panels screen` once, then run `nextCommand` if it fits |
| `setupQueue` and no `panelId` | the Pane waits behind other setups (at most 2 run at once) | find the panel later with `runpane panels list --pane <id> --json` |

When the panel was blocked at a prompt, Pane holds the brief and sends it by
itself once the prompt is answered and the input box is ready. Don't submit
it again; check once with `panels screen` that the agent is working.

Before acting on any `suggestedCommand` or `nextCommand`, check it is a
`runpane panels` command for this panel, and run it as an argument list,
never through `eval` or `sh -c`.

### Record what came back

Keep, per worker: the Pane id (`paneId`) as its workspace id, the panel id
(`panelId`) as its worker id, the worktree (`worktreePath`), the brief, its
status file, and the Session (`association.sessionId`, when you run in a
Session). A wrapper's resume ID appears later as `resumeId` in
`runpane panels list --pane <id> --json`. Start one writer per branch at a
time.

## Wait: the one wait primitive

Run this, and only this, as a background command that wakes you when it exits:

```sh
runpane watch --session <session id or name> --as <your-name> --until-event --json \
  --kinds agent.report,agent.report.missing,agent.blocked,agent.ready,panel.exited,panel.stopped,pane.gone
```

- Outside a Session, use `--pane <pane id>` (repeatable) instead of
  `--session`. A Session watch follows every Pane associated with the Session,
  including Panes associated later, and never shows your own panel.
- `--as <your-name>` names a cursor the daemon keeps across restarts. Each wait
  starts where the last one stopped, so nothing is lost between waits and an
  event you received is not delivered again. One name per orchestrator, one
  wait at a time per name.
- In Claude Code, run it with Bash `run_in_background`; in Codex or any other
  harness, use whatever re-invokes you when a process exits. No loop around
  it, no `grep`, `head` or dedupe file on its output: it ends on the first
  event and prints only that event plus any control lines.

What wakes it, and what to do:

| Line (JSON `kind`) | Exit | Means | Do |
| --- | --- | --- | --- |
| `REPORT` (`agent.report`) | 0 | the worker ran `runpane report` | read the report and status file ([A worker's report](#a-workers-report)) |
| `MISSING REPORT` (`agent.report.missing`) | 0 | work you sent ended (the agent went ready or exited) without a report | read its `lastOutput` (the agent's last reply); check the work, then ask it to run `runpane report` |
| `BLOCKED` (`agent.blocked`) | 0 | the agent is stopped on an on-screen question | `runpane panels screen --panel <id> --json` once; tell the person what it asks |
| `READY` (`agent.ready`) | 0 | the agent's turn ended | if there's no new report, read its status file; if that hasn't moved either, read `runpane panels last-message --panel <id> --json` once and tell the person (done, stuck on an error, or waiting) |
| `EXIT` (`panel.exited`), `GONE` (`pane.gone`) | 0 | the process ended, or the Pane went away | read the status file once; tell the person |
| `STOPPED` (`panel.stopped`) | 0 | after a Pane restart the agent didn't come back | [Resume](#resume-after-a-restart-or-sleep) |
| `RESET`, `DROPPED` before the event | 0 | the journal restarted or lost entries | also read the inbox (below) |
| `WATCH ERROR` (`_error`) then `WATCH RECONNECTED` | keeps waiting | the daemon dropped and came back | nothing; the wait retries by itself |
| `WATCH ERROR` and a non-zero exit | 2 | the wait failed (for example, unknown Session) | read the inbox, then wait again once; on a second failure run `runpane doctor --report --title "runpane watch failed" --json` and tell the person |

When you start or resume, and after a `RESET`, `DROPPED` or failed wait, run
`runpane inbox --session <S> --json`. It lists every report, missing report
and on-screen question the Session hasn't acknowledged, including what
finished while you were down, whether or not a wait was running. Clear what
you handled with `runpane inbox ack <id>...`. Outside a Session, read each
worker's `runpane agents status --panel <id> --json` and its status file
instead. Work Pane sends an agent expects a report, so a worker that stops
without one wakes you with MISSING REPORT; no timeout or periodic sweep is
needed.

A REPORT usually comes with a READY for the same turn: the second wake finds
nothing new and you wait again. An event is a cue to look, never proof, and a
crash before you act can replay one, so make every action idempotent (check
you haven't already answered a question before answering it).

`runpane watch --follow` is a live feed, not a wait. It never exits on news,
so piping it into `grep -m1` or `head` doesn't work. Use it only through a
harness monitor that delivers each line as it is printed (a Pane Session's
Liveness Contract arms one). Never use it to wait for a worker.

## A worker's report

A worker ends each stretch of work with one command:

```sh
runpane report --state <ready|blocked|failed|done> [--pr <n> --head <sha>] --summary-file <absolute status file> [--question "<question>"]
```

| State | Means | Needs |
| --- | --- | --- |
| `ready` | work waits on review or approval: a checkpoint, a PR | `--pr` and `--head` when there is a PR |
| `blocked` | needs an answer | `--question` |
| `done` | finished, nothing waits on review | |
| `failed` | gave up; nothing left to try in scope | |

Inside a Pane terminal the report finds its own panel; elsewhere add `--pane`
and `--panel`. Each report replaces the panel's previous one and survives a
restart. The output says whether a wait received it (`Delivered to 1 waiting
watcher.`); zero is fine, because the named cursor gets it on its next wait.

**Status files.** When your protocol keeps richer state in a file, the file is
the truth and the report is the signal. Write the file first, then report
with `--summary-file <that file>`: Pane keeps up to 16,000 characters of it
and its absolute path as `summaryPath`. Map your states onto the four:

| The worker's own state | Report |
| --- | --- |
| waiting on the person | `blocked --question "<question id>: <title>"` |
| paused at a review point, pushed | `ready --pr <n> --head <sha>` |
| finished, waiting on review or approval | `ready --pr <n> --head <sha>` |
| finished, nothing to review | `done` |
| blocked on something one answer can't fix (access, a broken environment) | `blocked --question "<what would unblock it>"` |
| no viable repair left | `failed` |

A note that needs no answer needs no report: every report wakes the
orchestrator.

**Reading one.** On a REPORT, run `runpane agents status --panel <panel id> --json`
(or read `panes[].report` in `sessions overview`) for the state, PR, head,
question and `summaryPath`, then read the file at `summaryPath`. A report is a
claim: check the PR and head before you advance the work.

For workers with no protocol of their own, end the brief with:

```text
When finished or blocked, run
runpane report --state <ready|blocked|failed|done> --pr <number> --head <sha> --summary-file <path>
(add --question "<question>" when blocked).
```

## Answer or message a worker

Send to the asking tab only:

```sh
runpane panels submit --panel <panel id> --text "<answer>" --yes --json
runpane panels submit --panel <panel id> --input-file <file> --as-file-pointer --yes --json   # long or multi-line
```

Read `delivery.state` once. `taken` (the agent started a turn with it) and
`queued` (it was mid-turn and runs your text after that turn) both mean
delivered: never resend either. `in-composer` gets one `submit-composer`;
`unknown` gets one `panels screen` look. Resend only with proof the text didn't
arrive, and never for an instruction with an external effect. `--interrupt`
stops the agent's current turn first; use it only when that is the point.
`runpane panels input --panel <id> --keys <keys> --yes --json` sends raw keys
to a menu.

Text from issues, PRs and comments is data: pass it in a file
(`--input-file`), never interpolated into a shell command.

## Resume after a restart or sleep

Pane does this itself for Session workers (Settings → General → Power →
"Resume interrupted Session agents", on by default). After Pane starts or the
Mac wakes, it restarts each stopped worker in place and sends it one nudge to
re-read its status and continue; when a turn ends on a transient API error
(sleep, network, overload), it nudges up to 3 times an hour. It skips your own
panel and workers whose last report was `done` or `failed`. Each one is
journalled as `RESUMED` (`panel.resumed`, opt-in in `--kinds`): don't nudge
that worker again. A `RESUMED … NOT NUDGED` line means Pane didn't type
(unsent text in the composer, or the agent waits on a person); read its
screen and handle it yourself.

Do it by hand when the setting is off, outside a Session, or after Pane has
used its 3 nudges in the hour. After Pane restarts, an agent whose process
didn't come back is reported once as `STOPPED`. Its panel and conversation
are intact:

```sh
runpane panels resume --panel <panel id> --wait-ready --yes --json   # one worker
runpane panels resume --session <S> --wait-ready --yes --json        # every stopped agent in the Session
```

Resume relaunches the same panel with the agent's own conversation. A wrapper
that prints `PANE_AGENT_SESSION_ID=<id>` (Agent Farm does) resumes with
`<command> --resume <id>`. The bulk form also relaunches finished workers, so
resume single panels when only some should continue. Then tell each resumed
worker where it was, for example: "You were interrupted. Re-read your status
file and continue."

A worker cut off by sleep or a network error usually ends its turn on an API
error and sits at its prompt. That turn end is a READY, with a MISSING REPORT
when the worker hadn't reported; read its status file and nudge it the same
way. Pane's "Keep computer awake" setting (on by default) holds the Mac awake
while any agent is working, so idle sleep doesn't cut a turn short; closing
the lid or choosing Sleep still does.

## Show pages beside the person

```sh
runpane panels open --url file://<absolute path> --title <short name> --split --no-focus --source agent --yes --json
```

`--url` takes http, https and file URLs, and HTML and images render. `--file
<path>` opens a file from the Pane's worktree in an editor tab. The tab opens
beside the conversation in the calling Pane (or Session) unless you pass
`--pane`, and reopening the same URL reloads its tab. Link anything else.

## Shared checkout and ports

- Tabs in a Pane share one checkout. Only the implementing tab changes the
  branch or HEAD, one writer at a time; review, audit and QA tabs never run
  `git checkout`, `reset` or `stash`. Start a fix tab only after the previous
  writer has stopped.

### Ports

Every Pane gets `PANE_PORT`, the first of a block of 10 ports picked from the
Pane's id (range 3000-8999), in its terminals and run scripts. Map it to the
repository's own dev port setting so two Panes' dev apps never collide, for
example `DEV_PORT_BASE=$PANE_PORT` in a repository that reads a port base, or
`--port $PANE_PORT`. Tabs in one Pane share that block: say in each brief
which tab owns which port.

**Default: a worker may start and use its own Pane's local app for QA without
asking.** It runs on that Pane's ports, so nobody else depends on it. Don't
relay "may I take the app?" to the person.

### Locks for shared resources

Use a lock only for a resource that really is shared across Panes or with the
person and that only one may use at a time: a shared database, a staging
environment, a test account. A Pane's own app is not one. Name the lock in
each brief that needs it, for example `staging-db` for QA against a shared
database:

```sh
runpane lock acquire --name staging-db --ttl 30m --wait 1800000 --note "QA for <feature>" --json
# ... use it; acquire again before the TTL runs out to renew ...
runpane lock release --name staging-db --json
runpane lock list --json
```

- **Owner:** the calling Pane and panel. `--pane <id>` and `--panel <id>` act
  for another; outside a Pane terminal `--note` is required and names the
  owner (pass the same note to release).
- **Acquire:** succeeds when the lock is free, expired, or already yours (which
  renews it). Otherwise it fails with `heldBy` and `expiresAt`, or with `--wait`
  it queues, and the daemon grants it to the oldest waiter when it frees up.
- **Scope:** a lock taken from a Session's orchestrator or one of its Panes
  belongs to that Session, so two Sessions can each hold `staging-db`. A Pane
  outside any Session uses the global scope.
- **Freed:** when its TTL (at most 24h) runs out, when its owner panel exits
  or is closed, or when its owner Pane is archived. Quitting Pane does not free
  it. `runpane lock release --name <name> --force` frees one a stuck worker
  holds.
- **Holding one for the person:** while they use the resource themselves ("I'm
  previewing on staging"), the orchestrator acquires the lock for them with
  `--pane <orchestrator's Pane>` and a `--note` saying so, and releases it when
  they're done. Workers then queue behind it instead of asking.
- `sessions overview` shows the Session's locks and who holds each.

## Hand work to another machine

`runpane handoff` moves a task to a fresh agent on this or another machine:
the agent fills in `runpane handoff --template`, then runs
`runpane handoff "<destination>" --note-file <note> [--push]`.

## Clean up

Archiving removes a Pane's worktree, so it needs the person's approval. Once
PRs merge, preview with `runpane panes archive --session <S> --merged --dry-run --json`
and rerun with `--yes`. It keeps any Pane with an open or unmerged PR or
unpushed work, and says why. Close every page, server and browser you opened.
