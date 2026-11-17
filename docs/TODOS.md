# To-dos

A to-do is one piece of work you want agents to do, with a title, a summary
and a list of checks that say when it is done. Pane gives every to-do you
start its own [Session](SESSIONS.md) and orchestrator agent, and keeps an
agent working on it until it is ready for your review. You read its progress,
answer its questions and accept the result on the to-do's page.

- **One list.** The To-dos screen lists every to-do on every machine, with
  the status you need: waiting on you, working, queued or idle.
- **Kept moving.** A plain-code supervisor on each machine notices a to-do
  that has gone quiet, reminds its orchestrator, restarts it, and then asks
  you. See [The supervisor](#the-supervisor).
- **Kind to the machine.** A load gate stops starting to-do agents while
  the machine is busy, and pauses some under heavy load that lasts. See
  [The load gate](#the-load-gate).

## What a to-do is

- **Title, summary and done-when.** The summary is Markdown. Done-when is a
  list of checks, such as "The sheet opens with ?"; agents and you tick them
  off.
- **Sub-to-dos.** A to-do can have sub-to-dos, one level deep. They live in
  the parent's Session, and its orchestrator assigns each to a worker tab.
- **Its own Session.** Starting a top-level to-do creates a Session named
  "T-41 · Title" on its machine, with the repo you chose and an orchestrator
  running your default agent (or the agent you picked). These Sessions stay
  out of the sidebar; open one from the to-do's page, sidebar search or
  Approvals.
- **A requester.** Whoever created the to-do: you, or the orchestrator of the
  Session whose chat it came from. Sub-to-dos share their parent's requester.
- **A number.** To-dos are numbered T-1, T-2 and so on per machine, and a
  number is never handed out twice.

## Statuses

Pane stores one of seven states: To do, In progress, In review, Accepted,
Stopped, Done and Dropped. The status you see is worked out each time from
the state, the to-do's approvals, the load gate and whether its agent is
mid-turn, so it never goes stale. The first that applies wins:

| Status | When |
| --- | --- |
| Waiting on you | An approval linked to the to-do, or to one of its open sub-to-dos, waits on you. A review counts. |
| Working | It is in progress or accepted, and the tab working it (or an open sub-to-do's) has been mid-turn for 10 seconds, by the same test as the Session spinner. |
| Queued | The load gate is holding its start, or paused it. The reason says which, such as "devbox is busy · starts when load comes down". |
| Idle | Anything else that is open, with a reason: not started, stopped, waiting for a usage limit, machine offline, or quiet. A to-do quiet for 10 minutes reads red. |
| Done | It was marked done after you accepted it, or you marked it done. |

## Creating a to-do

**On the To-dos page**, press **New to-do** (or C). Give it a title, and
optionally a summary, done-when checks, sub-to-dos, the repo, the machine
and the agent. **Start now** is on by default: Pane creates the to-do's
Session (through the load gate) and types the to-do in as the orchestrator's
first message. With Start now off, the to-do waits as To do until you press
**Start**.

**From an orchestrator**, with the CLI:

```bash
runpane todos create "Keyboard sheet" --summary "A ? sheet listing every shortcut." \
  --done-when "Sheet opens with ?" --done-when "Lists chat shortcuts" \
  --repo pane --attach tmp/plan/cover-sheet.html --json
```

A to-do created without `--parent` gets its own new Session and orchestrator,
the same as one you create, and the calling orchestrator becomes its
requester. `--no-start` saves it as To do. `--parent T-12` adds a sub-to-do in
T-12's Session instead; it inherits T-12's attachments. **+ Add sub-to-do** on
a to-do's page does the same, and Pane tells the parent's orchestrator so it
can assign a worker.

## The requester

A to-do's orchestrator asks its requester first, with
`runpane todos ask T-n "<question>"`:

- When the requester is an orchestrator, Pane types the question into its tab
  when it is idle. Its answer (`runpane todos comment T-n "<answer>"`) comes
  back to the to-do's orchestrator. If it can't settle the question, it runs
  `runpane todos comment T-n --escalate "<why>"` and the question comes to
  you.
- When the requester is you, or the requesting Session is gone, the question
  comes to you as an approval linked to the to-do.

The requester also gets one line when the to-do asks for review, is done, is
dropped, or is stuck.

## Attachments

A to-do's attachments are the plans, mock-ups, designs, PRs, findings files,
decision pages and other documents its work produced or relies on. They let a
new orchestrator, a worker on a sub-to-do, or you pick the work up without
hunting for it.

```bash
runpane todos attach T-12 tmp/plan/cover-sheet.html --kind plan --label "Plan" --json
runpane todos detach T-12 <attachment-id> --json
```

`--kind` is `plan`, `mockup`, `design`, `pr`, `findings`, `decision`, `doc`,
`image` or `link`; without it Pane picks one from the file (a PR link is a
`pr`, an image an `image`, a web address a `link`, and a file named `plan…`
such as `plan.md` the `plan`). A file stays a path on its machine and opens
from there. On the page, **+ Attach** takes a dropped file or a pasted link,
and clicking an attachment opens it in the split beside the chat.

**Inheritance is read, not copied.** A sub-to-do shows its own attachments,
then its parent's under "From T-12 (parent)". A parent shows its own, then
each sub-to-do's under "From T-14". A later attachment on the parent shows on
every sub-to-do at once.

**How Pane makes sure files get attached**, strongest first:

1. **Pane attaches what it can see.** A PR opened from a Pane of the to-do's
   Session or its assigned tab, the files on an approval linked to the
   to-do, and a page an assigned tab opens beside you with
   `runpane panels open`.
2. **Review needs attachments.** `runpane todos review` is refused when the
   to-do and its sub-to-dos have none, unless the agent passes
   `--no-attachments "<why>"`; the reason shows on the review card.
3. **One reminder.** After 20 minutes of agent work on an in-progress to-do
   (time mid-turn, not wall time) with no attachments, the supervisor types
   one reminder into the orchestrator's tab and logs it in the to-do's chat.
4. **Agent instructions.** Pane's own instructions (the Session folder's
   AGENTS.md, the pane-orchestrator skill, and the bundled pane-orchestration,
   runpane and pane skills) carry the rule: "Attach every plan, mock-up,
   design, PR, findings file and decision page you produce or rely on, as soon
   as it exists. Read a to-do's attachments before you start on it."

Every message Pane types to start or restart a to-do's agents, or to assign a
sub-to-do, lists the attachments (own and inherited) and says to read them
first. `runpane todos show T-n` lists them first too.

## The page

Opening a to-do (from the list, search, Approvals or a link) shows its page
with its **plan beside it** in a split at half the width.

- **Under the title**, a row of chips names where it stands, and each one
  opens what it names: the status (Waiting on you opens the approval), its
  agents (opens the Session), the PR and its checks (opens the PR tab),
  sub-to-do progress (scrolls to them) and the machine. With nothing
  attached the row reads "Nothing attached yet · + Attach".
- **The split** has a tab per attachment: the plan first, then mock-ups and
  designs, PRs, findings, decisions, docs, images and links, each in the order
  attached. A sub-to-do also shows its parent's, marked "from T-12". The plan
  opens first, or else the first tab in that order; ←/→ move between tabs. The
  bar under the tabs names the file, who attached it and when, with Open ↗ and
  ⋯ (Reveal, Detach). Drag the split's edge to resize it; the width is
  remembered for every to-do.
- **Hide the split** with the split button at the top right or ⌘\ (Ctrl+\ on
  Linux and Windows). It is the same key as a Session's Split Right, so
  rebinding Split Right in Settings rebinds this too. Hidden is remembered per
  to-do on this computer; the page then takes the full width and a
  "Plan · N files" chip shows the split again, as does clicking any
  attachment or approval. When the to-do area is under 1,000 px wide, every
  to-do opens with the split hidden and showing it lasts for that visit.
- **The details sidebar** (the panel button at the top right, as in a
  Session) starts closed on every to-do. Its Details tab has the status,
  Session, requester, who manages and works it, repo, machine, machine load
  with Never pause, keep moving, created and the sub-to-dos; its Attachments
  tab lists every attachment with who added it and when. Its width is
  remembered; opening it narrows the split. When there isn't room for the
  split, the thread and the details at once, the split steps aside until you
  show it again, which closes the details.
- **Approvals cover the split**, as in a Session: Answer, the status chip or an
  approval card in the thread shows the approval column over the split,
  headed "Back to Plan" (whatever tab was showing). ✕, Back or Esc returns to
  that tab, and so does answering.

## The chat

The thread under the to-do reads top to bottom, like an issue's activity:

- **Events** (created, assigned, attached, reminded, answered) are one line
  each. Two or more in a row fold into "Show N events: …"; an event whose
  approval still waits never folds, because its card shows instead.
- **Agent run cards**: one agent tab's messages and events in a row make one
  card, until another author's message comes between. It reads Working while
  that tab is mid-turn, Waiting on you while one of its approvals waits, or
  Finished, with the first line of its latest message. Expanded, it shows the
  messages, its steps and **Open in the Session chat**. Pane never shows an
  agent's tool steps here.
- **Comment cards** hold your messages and the requester's, with their
  replies under them. Under each message you send is "Delivered to …" or
  "Waiting for the agent to finish its turn".
- **Approval cards**: questions about the to-do are approvals linked to it.
  They show here and in Approvals, labelled with the to-do; answering in
  either place answers both. An agent links a question with `--todo T-n` on
  `runpane notify` or `runpane report`; without it, Pane links the question
  when the asking tab works on exactly one open to-do.

**Comment or reply.** The box at the bottom ("Leave a comment…", ⌘↵ to send)
goes to the to-do's orchestrator; on a sub-to-do the **To** switch picks its
assigned worker or the orchestrator. 📎, paste or drop attaches a file to the
to-do and names it in the comment. **Leave a reply…** under a card goes to
the agent that wrote it, typed into that agent's own tab; on your own card or
the requester's it goes wherever that card went. The agent's next message
from that tab threads under your reply while it is your newest unanswered one
to it. If that tab is closed, the reply goes to the orchestrator and the
thread says so. A reply can only reach a tab in the to-do's own Session or a
sub-to-do's assignee; anything else is refused (`ERR_TODO_REPLY_TARGET`).

Pane types what you send into the tab only when it is idle and you have no
unsent text there. **Agents reply** with `runpane todos comment T-n "<text>"`:
a short summary of at most 2,000 characters; longer replies are refused. The
page loads the newest 500 rows of activity.

## On the phone

To-dos come to the web app (the Remote PWA in a phone browser, and the
Capacitor shell that bundles it) under **To-dos** in its drawer, with the
waiting count. The iPhone app doesn't have them yet.

- The list is one column: filter pills that scroll sideways, rows of two
  lines (the title, then T-n and the reason) and **+** for a new to-do.
- A to-do shows its title and chips, a **Plan · N files** button, the summary,
  Done when, sub-to-dos with **+ Add**, and the thread, with the composer
  pinned to the bottom above the keyboard and the home indicator.
- **Plan · Files** opens the attachments full screen, with tabs that scroll
  sideways and **Open ↗**. An approval opens full screen too; sending returns
  to the to-do. New to-do and New sub-to-do are full-screen forms.
- Back (the header's, the browser's, or Android's in the shell) steps out
  approval → to-do → list, keeping your place.

The web app reaches the host's to-dos through the same `todos:*` channels as
the desktop, and its approvals through `notify:remote-snapshot` and
`notify:remote-command`.

## Review, accept, done

1. When every done-when check is met, the orchestrator runs
   `runpane todos review T-n --summary "<what to look at>"`. Pane raises a
   review approval listing the attachments, and the to-do reads Waiting on
   you.
2. You choose **Accept** or **Ask for changes**. Asking for changes sends your
   note back and returns the to-do to In progress.
3. Accept moves it to Accepted. The orchestrator does the wrap-up: merging
   only if you asked for that, cleaning up, and archiving the to-do's Panes
   (`runpane todos archive T-n`). The supervisor keeps an Accepted to-do
   moving like an in-progress one.
4. The orchestrator runs `runpane todos done T-n`.

An agent can mark a sub-to-do done whenever its done-when checks are met. It
can mark a top-level to-do done only after your Accept, or with
`--person-said "<your words>"` when you told it to; the quote shows in the
chat. Anything else is refused with an error pointing to `todos review`.
You can always **Mark done** yourself, or **Drop** a to-do whose work won't
be done.

## Archive

**Archive** on a done or dropped to-do, and `runpane todos archive` in the
orchestrator's wrap-up, archive the Panes of the to-do's own Session with the
same checks as `runpane panes archive --dry-run`. A Pane with uncommitted
changes, unpushed commits or a busy agent is kept, and the to-do says which:
"Archived 2 Panes. Kept keyboard-approvals: 2 unpushed commits." Nothing is
forced. Once every Pane is archived, Pane archives the Session too.
**Reopen** restores the Session and its archived Panes. Archiving a sub-to-do
archives nothing: its Panes belong to the parent's Session.

## The supervisor

While a to-do is In progress or Accepted, Pane keeps an agent working on it
until it is ready for your review. The orchestrator keeps its workers moving
with the watch it already runs ([Session watcher](SESSIONS.md#session-watcher));
the supervisor keeps orchestrators moving. It is plain code with fixed rules:
no agent decides when to nudge. It runs once a minute on each machine that
hosts Sessions, and each to-do has its own clock.

A to-do is **stuck** when it is in progress or accepted, not waiting on you,
not queued, no agent in its Session is mid-turn, and nothing has moved.
Progress is something that moves the work: an agent writes to the to-do (a
comment, an attachment, a sub-to-do or done-when change, a review request), a
commit or push lands in one of the Session's Panes, an approval is raised or
answered, or you comment. A turn on its own doesn't count.

| Quiet for | Pane does |
| --- | --- |
| 10 minutes | Types a reminder into the orchestrator's tab: `[From Pane, To-dos] T-12 "…" is in progress and nothing has moved for 10 minutes. Carry it on, ask for review with runpane todos review T-12, ask with runpane todos ask T-12, or say why it can't move.` |
| 20 minutes | A second reminder. |
| 30 minutes | Restarts the orchestrator in place, in its same conversation, and sends a third message saying so. While the load gate holds, the restart waits and the to-do reads Queued. |
| 40 minutes, or 10 minutes after a restart with no progress | Raises a card linked to the to-do: "T-12 has been stuck for 40 minutes. The orchestrator was reminded twice and restarted once." with **Restart its agents**, **Stop it** and **I'll look**. The to-do reads Waiting on you and the ladder stops until you answer. |

An orchestrator whose process stopped, whose tab is gone, or that has been
busy without a turn for 5 minutes is restarted without waiting for 30
minutes.

| Limit | Value |
| --- | --- |
| Per stuck episode | 2 reminders and 1 restart, then a card to you. |
| Per machine | 12 reminders and 4 restarts an hour, attachment reminders and launch restarts included. Past either, the rest go straight to a card. |
| Repeat stalls | A to-do stuck 3 times in a day goes straight to a card at its next stall. |
| Never | While an agent in the Session is mid-turn, while you have unsent text in the orchestrator's tab, or while the to-do waits on you, is queued or is stopped. |
| Usage limit | When Pane knows the orchestrator is at its usage limit, the ladder pauses, and at the reset Pane sends one reminder. |
| Machine offline | Nothing runs; the desktop shows the to-do as Idle · machine offline. The supervisor lives on the machine. |

**When Pane starts or wakes**, the supervisor lists the to-dos that are in
progress or accepted, not stopped and not waiting on you, grouped by Session.
For each Session it restarts the orchestrator and the tabs assigned to those
to-dos and their open sub-to-dos, in their same conversations, three tabs at a
time and only while the load gate allows. Each orchestrator then gets one
message naming what was in progress and its attachments. To-dos that are
waiting on you, stopped or not started stay down, and the gate's held ones
read Queued. A connected machine does the same for its own to-dos when its
Pane starts.

## The load gate

There is no fixed limit on how many to-dos run at once. Pane watches the
machine instead. While any to-do is in progress or queued, it reads
machine-wide CPU (every app, all cores) and the operating system's memory
pressure every 10 seconds, using [Machine health](MACHINE_HEALTH.md)'s
readers. Each machine runs its own gate on its own load.

| Gate | Enters when | Leaves when | What Pane does |
| --- | --- | --- | --- |
| Normal | | | Starts to-do agents. Queued to-dos start one every 30 seconds. Paused ones resume first, after 5 minutes of Normal, one every 2 minutes. |
| Holding | CPU averages 85% or more over 60 seconds, or memory pressure is Warning or worse for 30 seconds | CPU below 70% and memory OK, both for 2 minutes | Holds every start for to-dos, which read Queued, and refuses agent starts from a to-do's Session with `machine_busy`. |
| Shedding | CPU at 95% or more for 3 minutes, or memory pressure Critical for 60 seconds | CPU below 85% and memory not Critical for 2 minutes (back to Holding), or the Normal condition (back to Normal) | Everything Holding does, and pauses one in-progress to-do every 2 minutes, the most recently started first. |

**What waits.** Everything Pane starts for a to-do goes through the gate:
creating its Session and orchestrator, Start, Resume, Reopen, supervisor
restarts, launch resume, and resuming a stopped tab to deliver an answer.
Reminders are only typing, so they still go out. The To-dos list shows one
line under Queued, such as "devbox is busy: memory pressure high for 3 min",
and every change of gate state is logged.

**Agent starts from a to-do's Session** (`runpane agents start`,
`panes create` or `panels create` with an agent, or any start with
`--todo T-n`) are refused while the gate holds, with a `machine_busy` error
that says what is busy. A sub-to-do the start named reads Queued. When the
gate returns to Normal, Pane types `[From Pane, To-dos] Capacity is back on
devbox; you can start agents again.` into each refused tab.

**Shedding** tells the to-do's orchestrator: "Pausing T-23 for machine load:
finish your current step, commit, and stop. Pane resumes you when load comes
down." Once its tabs are idle, or after 10 minutes at most, Pane pauses them
the way it pauses Panes, keeping each conversation for resume. The to-do reads
Queued · paused for load.

**Floors.** Pane never pauses a to-do that waits on you, one set to **Never
pause**, one with your unsent text in a tab, or one whose Pane you pinned or
are looking at. It never pauses the last running to-do, so one always keeps
moving.

**Your overrides, per to-do.** **Start anyway** on a queued to-do starts it
now and marks it Never pause. **Never pause** in the to-do's details keeps a
running to-do out of shedding. Both show in the chat.

**Turning it off.** Settings › Machine health › **Hold to-do agents when this
machine is busy**, on by default. Off, the gate still measures but never holds
or sheds. The thresholds can't be edited yet.

## What Pane types into agents' tabs

Pane types every to-do message into a tab only when the agent is at its
prompt and nobody has unsent text there. Each line names where it came from:

| Line starts with | From |
| --- | --- |
| `[From Pane, To-dos]` | Pane itself: a new orchestrator's first message, a sub-to-do assignment, a reminder or restart, a pause for load, capacity back, an attachment reminder, or an update for a requester. |
| `[From the person, via To-dos T-n]` | Your own words from the to-do's page: a chat message, Accept, Ask for changes, Stop, Resume or Drop. A chat message ends by telling the agent to answer with `runpane todos comment T-n "…"`, because a reply typed only in its tab never reaches the to-do's chat. |
| `[From <name>, via To-dos T-n]` | A reply in the to-do's chat from its requester or a worker, delivered to its orchestrator. |
| `[From To-dos T-n, asked by its orchestrator]` | A question for the requester, with how to answer it. |

## Storage

To-dos live in the host machine's `sessions.db`, in three tables added on
upgrade (`main/src/database/todosSchema.ts`):

- `todos`: one row per to-do, with its state, requester, assignee and the
  supervisor's and gate's counters.
- `todo_attachments`: one row per attachment, with its kind, target, machine,
  who attached it and how (`attached`, `pr`, `approval` or `opened`).
- `todo_activity`: the chat's messages and events; `reply_to` names the row a
  reply answers.

Approvals gain a `todo_id` column. All of it is additive (`reply_to` is added
to databases from earlier to-do builds when they open), so an older Pane
opening the same database still starts. Done and dropped to-dos, their
attachments and activity are deleted 30 days after they close.

## From the CLI

Every command takes a to-do as `T-12` or `12`, and `--json`. Each call
records the calling tab (`$PANE_PANEL_ID`).

```bash
runpane todos create "<title>" [--summary <md>] [--done-when <text>]... [--parent T-n] \
  [--repo <name|id>] [--agent <id>] [--attach <file|url>]... [--no-start]
runpane todos update T-n [--title <title>] [--summary <md>] [--done-when <text>]... [--check N]... [--uncheck N]...
runpane todos attach T-n <file|url> [--kind plan|mockup|design|pr|findings|decision|doc|image|link] [--label <label>] [--note <text>]
runpane todos detach T-n <attachment-id>
runpane todos show T-n
runpane todos list [--all]
runpane todos assign T-n [--panel <tab-id>]
runpane todos ask T-n "<question>"
runpane todos comment T-n "<text>" [--escalate]
runpane todos review T-n [--summary <text>] [--no-attachments "<why>"]
runpane todos done T-n [--person-said "<their words>"]
runpane todos drop T-n [--reason <text>]
runpane todos archive T-n
runpane todos start T-n
runpane todos stop T-n
```

- `update --done-when` replaces the list; lines that stay keep their checks.
  `--check` and `--uncheck` take 1-based line numbers.
- `list` shows open to-dos; `--all` adds those closed in the last 7 days.
- `assign` without `--panel` hands the to-do back to its Session's
  orchestrator.
- `--todo T-n` on `runpane notify`, `runpane report` and `runpane agents start`
  links that card, report or new agent to a to-do. An agent started with
  `--todo` is assigned that to-do.

The full contract is in [RUNPANE_CLI_CONTRACT.md](RUNPANE_CLI_CONTRACT.md).

## Testing

To try the supervisor and the gate without waiting or loading the machine,
start a dev build with an isolated `PANE_DIR` and:

- `PANE_MEMORY_PRESSURE_TEST_LEVEL` (`ok`, `warning` or `critical`) fixes the
  memory pressure reading ([Machine health](MACHINE_HEALTH.md#testing)).
- `PANE_CPU_LOAD_TEST_PERCENT` (0 to 100) fixes the machine-wide CPU reading.
- `PANE_TODOS_TIME_SCALE=<n>` runs the to-do clock n times faster, so with
  60 the supervisor's 10, 20, 30 and 40-minute ladder and the gate's windows
  pass in seconds. Unpackaged builds only; a packaged Pane ignores it.

Journeys run in an isolated Pane with the scripted agent:
`tests/todos.spec.ts` and `tests/todos-page.spec.ts`
(`playwright.chat-tabs.config.ts`). The page frame, the thread and the web
app also run on the renderer alone with fixture to-dos, in CI:
`tests/todos-page-frame.spec.ts`, `tests/todos-thread.spec.ts` and
`tests/remote-pwa-todos.spec.ts` (`playwright.ci.minimal.config.ts`). `tests/todos-real.spec.ts` runs real
Claude Code and Codex, only with `TODOS_REAL=1`.

The code is in `main/src/services/todos/`: `supervisorRules.ts` (the ladder
and limits), `loadGate.ts` (thresholds), `todoMessages.ts` (every line Pane
types), `todoService.ts` and `todoStore.ts`.
