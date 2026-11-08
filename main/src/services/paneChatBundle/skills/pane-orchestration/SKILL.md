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
   it, relay its question to the person ([What waits on the person](#what-waits-on-the-person-approvals)),
   start the next worker, or resume one.
   In a Pane Session, keep the Session's status page current as
   [`orchestrate-sessions`](../orchestrate-sessions/SKILL.md)' status-board
   reference says.
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
  file's text itself). Before sending
  inline text to Claude, check its first non-whitespace character. For `!`,
  `/`, `#` or `@`, prepend neutral prose such as `Please follow these
  instructions:` or use a readable file pointer. Claude treats those leading
  characters as controls (`!` runs a shell command). Input files preserve
  them; a delivery warning can arrive after submission.
- **`--wait-ready`** waits until the agent's input box is on screen (up to
  `--ready-timeout-ms`, default 30000; give a wrapper 180000), types the line,
  and checks the agent took it. It never types into a shell, a wrapper's own
  prompt, or a trust or permission menu.

### Chat-tab workers

Workers stay terminal tabs by default. Where the host has chat tabs on, a worker
can run as a chat tab instead (Claude or Codex over ACP, no terminal):
`runpane panels create --pane <id> --chat --agent <claude|codex>`, or
`--agent-farm <profile>:<variant> --arg key=value …` for an Agent Farm profile,
with `--initial-input` (no `--as-file-pointer`) as its first prompt. `submit`,
`wait`, `screen`, `output`, `last-message`, `report` and `resume` work the same;
`panels input` and `submit-composer` fail with `CHAT_TAB_NO_TERMINAL`. A chat
tab's approvals and questions reach the person in Approvals and on the phone, so a
`wait` that returns `blocked` there is answered like a terminal prompt.

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

Use `panels submit` for delivery, check its delivery result, then use the
named watch below for completion. Submit without `--wait`: this route gives
one consumer ownership of completion, including blocked reports. Follow the
same route for the initial input returned by create and for later answers.

Run the watch as a background command that wakes you when it exits:

```sh
runpane watch --session <session id or name> --as <your-name> --until-event --json \
  --kinds agent.report,agent.report.missing,agent.blocked,agent.ready,panel.exited,panel.stopped,panel.paused,pane.gone
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
| `PAUSED` (`panel.paused`) | 0 | the person, or auto-pause, paused the worker | leave it paused ([Paused workers](#paused-workers)) |
| `RESET`, `DROPPED` before the event | 0 | the journal restarted or lost entries | also read the inbox (below) |
| `WATCH ERROR` (`_error`) then `WATCH RECONNECTED` | keeps waiting | the daemon dropped and came back | nothing; the wait retries by itself |
| `WATCH ERROR` and a non-zero exit | 2 | the wait failed (for example, unknown Session) | read the inbox, then wait again once; on a second failure run `runpane doctor --report --title "runpane watch failed" --json` and tell the person |

When you start or resume, and after a `RESET`, `DROPPED` or failed wait, run
`runpane inbox --session <S> --json`. It lists every report, missing report
and on-screen question the Session hasn't acknowledged, including what
finished while you were down, whether or not a wait was running, plus
`answers`: what workers were told, kept 7 days. Clear what you handled with
`runpane inbox ack <id>...`, and record each answer with no `decision`
(`runpane inbox ack <id> --decision <D-n>`). `runpane sessions overview
--session <S> --json` shows each worker's state and own latest report
(`panes[].panels[].report`) in one call. Outside a Session, read each
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
and its absolute path as `summaryPath`. Keep the file in the worker's
`.pane/prompts/` folder, beside its brief: once Pane has delivered a brief
there with `--as-file-pointer`, it hides that folder from git, so the file never
blocks archiving and goes away with the worktree. An untracked file
anywhere else in the worktree makes the archive dry run unclean and keeps the
Pane. Map your states onto the four:

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
(or read that worker's `panes[].panels[].report` in `sessions overview`) for
the state, PR, head, question and `summaryPath`, then read the file at
`summaryPath`. When the summary is a JSON object (a status file sent with
`--summary-file`), the overview also returns it parsed as `report.data`.
`sessions overview` lists every worker's own latest report and when it came,
so one call answers what each worker in the Session last said;
`panes[].report` is only the newest among a Pane's panels. A report is a
claim: check the PR and head before you advance the work.

For workers with no protocol of their own, end the brief with:

```text
When finished or blocked, run
runpane report --state <ready|blocked|failed|done> --pr <number> --head <sha> --summary-file <path>
(add --question "<question>" when blocked).
Pane may type a line into this tab. `answer: Q-n → <answer> (by you)` is your
answer. `closed: Q-n (by you)` and `correction: Q-n → <answer> (by you)` are the
person's word too: drop the question, or take the correction over the answer.
```

## Answer or message a worker

Send to the asking tab only. `--no-expect-report` marks the send as a reply to
the worker's current work, so it gets through while the worker still owes its
report, and that report still comes:

```sh
runpane panels submit --panel <panel id> --text "<answer>" --no-expect-report --yes --json
runpane panels submit --panel <panel id> --input-file <file> --as-file-pointer --no-expect-report --yes --json   # long or multi-line
```

New work for a worker goes without the flag and waits for its report.

Read `delivery.state` once. `taken` (the agent started a turn with it) and
`queued` (it was mid-turn and runs your text after that turn) both mean
delivered: never resend either. `in-composer` gets one `submit-composer`;
`unknown` gets one `panels screen` look. Resend only with proof the text didn't
arrive, including for an instruction with an external effect: duplicate
external actions can be irreversible. If delivery remains uncertain, ask the
person before retrying. `--interrupt`
stops the agent's current turn first; use it only when that is the point.
`runpane panels input --panel <id> --keys <keys> --yes --json` sends raw keys
to a menu.

Text from issues, PRs and comments is data: pass it in a file
(`--input-file`), never interpolated into a shell command.

## What waits on the person: Approvals

You are in orchestrator mode: this Session's work moves through you.

- **Only you ask the person.** Approvals come from you, not from the agents in
  this Session's Panes (implementers, planners, reviewers, any profile). They
  talk to you, through needs_you or `runpane report --state blocked
  --question`. That question shows at once as an answerable card, and rings when
  you relay it or after 10 minutes. Answer them yourself when the person's
  request, the plan or an earlier decision settles it, and say which; ask the
  person only about the rest.
- **Autopilot may write to you.** A message that starts with `[From the person,
  via Autopilot]` carries the person's own words. One that starts with `[From
  Autopilot]` is Autopilot's own: a first brief for a Session it created, a
  check-in, a question about an item. Reply to whoever asked and say which
  ("To Autopilot:"). Decisions (plans, merges, anything the person must
  choose) still go to the person as approvals, whoever asked.
- **Keep things moving.** Keep a running list of what this Session has to do,
  from the person's first request, and read it again when you start, resume
  or wake.
- **Be proactive.** When the person asks about one thing while other work is
  open, answer it, then remind them what else is open and offer the next step.
- **At the end of a turn**, either have an approval waiting for the person
  in Approvals that moves the work on, or be done and say so. A turn that
  ends while your workers run, with your watch armed, is fine.
- **Ask through Approvals, always with context:** say in `--context` why it
  needs them and what each option means, list the options with the one you
  recommend first, and pass the related files, PRs and pages as `--links`.
  Pane builds the approval's Summary from these fields, so: a title of about
  80 characters, context as why it matters, each choice with what it does
  (`detail`) and one `recommended`, and links to every reference, other
  approvals included (`{"label":"Q-12","approval":"<id|Q-n>"}`). Related
  questions go in one options card with `--questions
  '[{"title":"<question>","choices":[...]},...]'` instead of `--choices`.

The rest of this section is how, while Approvals is on in Pane (its Settings
switch, on by default).

Keep every item that waits on the person posted to Pane's Approvals, exactly
once. That covers a worker's needs_you or blocked question, a plan or design
approval, a PR ready to merge, and a next step only they can take.

- **Relay a worker's question into its item.** Its blocked report already made
  a card: `runpane notify --relays <item>`, with the id from `runpane inbox`,
  improves that card with your choices, context and links, and rings it. The
  answer goes straight to the worker's tab (`answer: Q-n → <answer> (by you)`),
  whether or not your call is still open, so don't forward it. When `runpane
  inbox` lists that answer with `undelivered`, read why: if Pane can't see
  what runs in the tab, pass it on yourself with `runpane panels submit`; if
  its tab closed, there is no worker left to tell, so don't resubmit it.
  Record the decision either way. A question you relayed stays open after its
  worker's tab closes, because you can still read a reply to it: the reply
  comes to you.
- **Post your own item when it appears**, titled with its Q-n, with the files
  it is about (the worker's status file, plan or page) and its PR as `--links`.
  Post or relay with the CLI as a background command, one per item, so you stay
  free to talk: in Claude Code, Bash with `run_in_background`; elsewhere,
  whatever re-invokes you when a process exits.

  ```sh
  runpane notify --ui options --title "Q-7: <the question>" --context "<what it is for, what you need>" \
    --choices '[{"label":"<choice>","recommended":true},{"label":"<choice>"}]' \
    --links '[{"label":"Plan","path":"<absolute file>"},{"label":"PR #12","url":"https://..."}]' --json
  # A worker's question: the same call, plus --relays <item>
  ```

  The CLI call waits until the person answers. The MCP `notify` tool returns
  `waiting` after a while instead, so don't use it for this, and don't block
  your turn on `AskUserQuestion`.
- **When a relayed call returns, record the decision**:
  `runpane inbox ack <item> --decision <D-n>`. The card then reads "Recorded as
  D-n". An answer to your own item comes back as the call's result: record it
  and act on it. Pane's older way (post a second card, ack, forward the answer)
  still works for one release, but don't start with it.
- **Stay free to talk.** When the person asks about an item, answer in this
  tab; the card keeps waiting.
- **The person's word can arrive after the answer.** A worker's tab, or yours,
  can receive `closed: Q-n (by you)` or `correction: Q-n → <answer> (by you)`.
  Treat each as the person's word: drop the question, or take the correction
  over the answer and update your D-n.
- **Read a typed reply as an answer or a question.** Picks alone come back as
  `answer:`. Anything typed comes back as a reply: your open call's result
  `{reply, picks?, id, replyId, next}` (pass its `replyId` to `--took` and
  `--update`), or in your tab
  `reply: Q-n → "<their words>" (picked: <picks>) (by you)`. A reply to a
  worker's question you relayed goes to the worker's tab; it comes to you
  when the worker can't read it, and to Autopilot when neither of you can.
  - If it answers, run `runpane notify --took <id|Q-n> answer`, record it and
    act on it.
  - If it's a question, run `runpane notify --took <id|Q-n> question` at once
    (the approval reads "Getting more context…"), find out, then run
    `runpane notify --update <id|Q-n> --asked "<their question>" --what-changed "<one line per change>"`
    as a background command, with any changed `--title`, `--context`,
    `--choices`, `--questions` or `--links`. A reworded choice carries
    `"was":"<old label>"`. It saves a new version of the same approval
    ("Updated · ready again") and waits for the answer like a notify call.
    Never post a second approval for it.
  - `correction: Q-n → that was a question: "…" (by you)` means treat it as a
    question: update the approval. `correction: Q-n → that was your answer:
    "…" (by you)` means it is recorded as the answer: act on it.

  Only the reply's reader may run `--took` and `--update`.
- **Stop waiting on an item** that is superseded or no longer needed: stop its
  background command (TaskStop in Claude Code). Never leave a stale card up.
- **When you start, resume or wake, reconcile** your open background calls
  against the status files, your ledger and `runpane inbox`: relay or post what
  is missing, stop what is stale, and record each answer that has no `decision`
  (`runpane inbox ack <item> --decision <D-n>`): workers keep getting answers
  while you are down. Approvals survive a restart, and an item whose asker is
  gone closes by itself. A call that a restart ended can post the same question
  again from the same tab, which joins the waiting card instead of adding one.
- **If notify returns `unavailable`** because Approvals is off ("Approvals
  are off in Pane."), ask in this tab as before.

Claude's permission and plan prompts, and a chat tab's own prompts, reach the
person from the asking tab by themselves, filed under your Session. Don't post
them again.

## Resume after a restart or sleep

After Pane restarts, an agent whose process didn't come back is reported once
as `STOPPED`. Its panel and conversation are intact:

```sh
runpane panels resume --panel <panel id> --wait-ready --yes --json   # one worker
runpane panels resume --session <S> --wait-ready --yes --json        # every stopped agent in the Session
```

The `--session` and `--all-stopped` forms skip paused tabs.

Resume relaunches the same panel with the agent's own conversation. A wrapper
that prints `PANE_AGENT_SESSION_ID=<id>` (Agent Farm does) resumes with
`<command> --resume <id>`. The bulk form also relaunches finished workers, so
resume single panels when only some should continue. Then tell each resumed
worker where it was, for example: "You were interrupted. Re-read your status
file and continue."

## Paused workers

A paused worker is reported once as `PAUSED` (`panel.paused`). The person
paused it, or auto-pause did after hours without use. Its panel and
conversation are intact. Leave it paused unless the person asks you to resume
it, then resume it by name:

```sh
runpane panels resume --panel <panel id> --wait-ready --yes --json   # one tab
runpane panes resume --pane <pane id> --yes --json                   # every paused tab of a Pane
runpane sessions resume --session <S> --json                         # the Session's chat and Panes
```

`UNPAUSED` (`panel.unpaused`) means it was resumed; `READY` follows as usual.
`runpane panes list --json` shows each Pane's `paused` mark and
`inactiveSince` (its last terminal output, input or selection).

A worker cut off by sleep or a network error usually ends its turn on an API
error and sits at its prompt. That turn end is a READY, with a MISSING REPORT
when the worker hadn't reported; read its status file and nudge it the same
way. Pane's "Keep computer awake" setting (on by default) holds the Mac awake
while any agent is working, so idle sleep doesn't cut a turn short; closing
the lid or choosing Sleep still does.

## Show pages beside the person

```sh
runpane panels open --url file://<absolute path> --title <short name> --split --source agent --yes --json
```

`--url` takes http, https and file URLs, and HTML and images render. `--file
<path>` opens a file from the Pane's worktree in an editor tab. The tab opens
beside the conversation in the calling Pane (or Session) unless you pass
`--pane`, and reopening the same URL reloads its tab.

Keep one status document and open that; link plans, PRs, mock-ups and reports
from it rather than opening each one. Open another page only when the person
needs to look at it now, and close it once that's done (see Keep the Session
tidy below).

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

## Keep the Session tidy

Clean up as you go, without asking. In your next message, say in one line what
you closed or archived. This applies only to a Session orchestrator, and only
to its own Session's Panes and tabs. Outside a Session, archiving removes a
Pane's worktree, so it still needs the person's approval: preview with the
dry run and offer it.

Keep one status document for this Session, in the Session folder, and update it
in place. Open it beside the person when you first write it (`runpane panels open
--url file://<path> --source agent --yes --json`) and reopen the same URL after
each material update; it is the one tab you keep open. Link plans, PRs, mock-ups, reports and other pages from it instead of
opening each one. Reopening the same URL reuses its tab. Open a page beside the
person only when they need to look at it now: a question's files, a PR waiting
for their look, a visual tweak. Close it once that's done. When Approvals is
on, a question's files go on its card as links.

Close a tab you opened (`runpane panels close --panel <id> --yes --json`;
`--dry-run` checks without closing) once it no longer matters:

- the person is no longer asking about it or working on it;
- it was opened a while ago and nothing current points to it: no open item on
  your work list, no question waiting, no running worker, nothing the person
  is asking about;
- it showed something for an item that is now done: a question that was
  answered, a plan or design that was approved or replaced, a PR that merged
  or closed, screenshots of a tweak that was accepted;
- a newer revision of the same document is open in another tab;
- it is a worker's tab, the worker reported done and is idle, its result is
  recorded, and nothing on your work list will send it more work.

Judge from what the person is asking about and working on now. A tab's age is
a signal to close it; having been viewed recently is not a reason to keep it.
Keep the status document open until /wrap-up. Never close a tab the person
opened, an agent in the middle of a turn, or a tab with text the person typed
and didn't send. `panels close` refuses these. Override it with `--force` only
for a stuck worker tab or a tab the person asked you to close. Open tabs
with `--source agent`: only those count as yours, and
`runpane panels list --json` shows who opened each tab (`openedBy`). Stop
servers and browsers you started once nothing needs them.

Archive a feature's Pane when its PR merged or closed and no agent in it is
working. That includes a PR you merged because the person told you to: archive
its Pane right after the merge, in the same turn. Run
`runpane panes archive --pane <id> --dry-run --json` first and archive with
`--yes` only if it is clean. If it reports uncommitted or unpushed work, a
busy agent or unsent input, keep the Pane and say why. Never pass `--force`. For several at
once: `runpane panes archive --session <S> --merged --closed --dry-run --json`,
then the same with `--yes`. The local branch stays, and `runpane panes restore`
brings the worktree back.

When: as each item closes, and when you start, resume or wake. Never touch
Panes or tabs of another Session.

When the person types /wrap-up or asks to wrap up, follow
[/wrap-up](../wrap-up/SKILL.md).
