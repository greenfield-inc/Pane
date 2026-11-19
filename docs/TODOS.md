# To-dos

A to-do is one piece of work you want agents to do, with a title, a summary
and a list of checks that say when it is done. Pane gives every to-do you
start its own [Session](SESSIONS.md) and orchestrator agent, and keeps an
agent working on it until it is ready for your review. You read its progress,
answer its questions and accept the result on the to-do's page.

- **One list.** The To-dos screen lists every to-do on every machine, once
  each, with the status you need: waiting on you, working, queued or idle. A
  saved machine that is this computer (or, in remote mode, the computer the
  window shows) isn't read a second time. Opening another machine's to-do
  (its row reads Open on devbox) switches the window to that machine and
  shows the to-do there; an offline machine says so instead.
- **Kept moving.** A plain-code supervisor on each machine notices a to-do
  that has gone quiet, reminds its orchestrator, restarts it, and then asks
  you. See [The supervisor](#the-supervisor).
- **Snooze it for later.** A to-do can sleep until a time with a wake-up
  note; then Pane wakes its agents with the note, or shows you a reminder.
  See [Snoozing and reminders](#snoozing-and-reminders).
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
  out of the Sessions sidebar, the web app's sidebar, All machines and Add to
  Session, even while open: the Session records its to-do's number when it
  is created, so no list waits for the to-dos to load to hide it. Open one
  from the to-do's page, sidebar search or Approvals.
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
| Waiting on you | An approval linked to the to-do, or to one of its open sub-to-dos, waits on you. A review counts, and so does anything asked inside the to-do's own Session without `--todo` (an agent's permission prompt, say), which also shows on its page. A snoozed to-do with a waiting approval reads Waiting on you, with "snoozed until …" after it. |
| Snoozed | It is snoozed until a time. The reason reads "until Wed 9:00 AM" and the note's first line, or ends "· machine offline" when its machine can't be reached. See [Snoozing and reminders](#snoozing-and-reminders). |
| Working | It is in progress or accepted, and the tab working it (or an open sub-to-do's) has been mid-turn for 10 seconds, by the same test as the Session spinner. |
| Queued | The load gate is holding its start, or paused it. The reason says which, such as "devbox is busy · starts when load comes down". |
| Idle | Anything else that is open, with a reason: not started, stopped, waiting for a usage limit, machine offline, or quiet. A to-do quiet for 10 minutes reads red. |
| Done | It was marked done after you accepted it, or you marked it done. |

**Where a to-do's approvals show.** Every approval of a to-do (its review,
a stuck card, its agents' questions and permission prompts, including ones
asked inside its own hidden Session) shows in Approvals, labelled with the
to-do, and on the to-do's page. It also counts on the sidebar row of the
Session that requested the to-do, and opens in that Session's Approvals
column, each counted once, in All machines too.

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
  comes to you as an approval linked to the to-do. Your answer, picked or
  typed, is typed into the tab that asked as `[From the person, via To-dos
  T-n] Answer to your question: …`, or into the to-do's orchestrator when the
  question came from outside a tab.

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
from there; Pane keeps no copy, so once the file is gone (its Pane archived, its
scratch folder cleaned) the to-do says it isn't on that machine anymore. On the page, **+ Attach** takes a dropped file or a pasted link,
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

## The list

The To-dos screen has a tab for each view (Open, Waiting on you, Snoozed and
Closed) and groups each by status, requester, repo or machine. By status the
groups read Waiting on you, Working, Queued, Idle, then Snoozed, soonest
first.

### Folding groups

Every group folds, in every grouping, on the desktop and in the web app.

- Click or tap a group's header: its chevron turns and its rows hide. The
  header keeps its count; a folded Snoozed header also reads "next wakes Wed
  9:00 AM".
- With the keyboard, ← on a row folds its group and selects the header. →,
  Enter or Space on a folded header opens it and selects its first row. J and
  K stop once on a folded header and never on the rows inside it. The footer
  reads "← → fold · open group".
- Folds are remembered for each pair of tab and grouping: folding Idle in
  Open by status doesn't fold it in Open by repo. The desktop keeps them in
  each window's saved state; the web app keeps them in that device's
  browser storage.
- Snoozed starts folded wherever there are other groups, until you open it.
  In the Snoozed tab, where it is the only group, it starts open.
- A row's group comes from its status, so a to-do that wakes leaves Snoozed
  and joins its usual group, folded or not; a selected row keeps its
  selection. Snoozing a row into a folded Snoozed moves the selection to the
  next row and shows "Snoozed T-14 until Wed 9:00 AM · Show".

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
- **Every tab closes**, as in a Session's split: ✕ shows on the tab under the
  pointer and on the one shown, and the close-tab key (⌘W, Ctrl+W on Linux
  and Windows; the same binding as a Session's Close active tab) closes the
  shown tab, or the approval over the split. Closing never detaches: Detach
  stays in the file bar's ⋯. Closed tabs are remembered per to-do on this
  computer; a file attached later still gets its tab. Opening a file again
  (a chip, a thread card, the details' Files, + Attach) reopens its tab where
  it was. Closing the last tab hides the split; the split button or ⌘\ shows
  it again with the plan (else the first tab) reopened. "Plan · N files"
  counts every file, closed or not, and with every tab closed it opens the
  details' Files instead. In a Session's To-dos tab the key stays the
  Session's.
- **Hide the split** with the split button at the top right or ⌘\ (Ctrl+\ on
  Linux and Windows). It is the same key as a Session's Split Right, so
  rebinding Split Right in Settings rebinds this too. Hidden is remembered per
  to-do on this computer; the page then takes the full width and a
  "Plan · N files" chip shows the split again, as does clicking any
  attachment or approval. When the to-do area is under 1,000 px wide, every
  to-do opens with the split hidden and showing it lasts for that visit.
- **The Session's Overview** is a tab in the split, after the plan, when the
  to-do (or its parent) has a Session on this machine: the same goal, next
  step, decisions, Panes and activity as the Session's own Overview tab.
- **To the Session and back.** The agents chip (or Session in the details)
  opens the to-do's Session chat. A bar above the Session's tabs reads
  "← T-12 · Invoice PDFs" with the to-do's status; one click returns to the
  to-do. No key is bound there: Esc belongs to the agent's tab.
- **The details sidebar** (the panel button at the top right, as in a
  Session) starts closed on every to-do. Its Details tab has the status,
  Session, requester, who manages and works it, repo, machine, machine load
  with Never pause, keep moving, created and the sub-to-dos. Its **Files** tab
  is a file browser of the to-do's own files, its sub-to-dos' ("from T-14")
  and its parent's, with what Pane attached itself (its PR, an approval's
  files, a page opened beside you). A search box filters by label, path and
  note; the files are grouped by kind in the split's tab order (Plan,
  Mock-ups, Designs, PRs, Findings, Decisions, Docs, Images, Links), each with
  a count. A row reads where the file came from, its machine when it isn't
  this one, and how long ago; one whose tab is closed is marked "closed".
  Clicking a row (or Enter) shows it in the split, and ⋯ has Open outside and,
  for the to-do's own files, Detach. It updates as files are attached, and on
  another machine's to-do it opens files through that machine. Its width is
  remembered; opening it narrows the split. When there isn't room for the
  split, the thread and the details at once, the split steps aside until you
  show it again, which closes the details.
- **Approvals cover the split**, as in a Session: Answer, the status chip or an
  approval card in the thread shows the approval column over the split,
  headed "Back to Plan" (whatever tab was showing). ✕, Back or Esc returns to
  that tab, and so does answering.

## In a Session

Every Session's split has a **To-dos** tab after Overview: the top-level
to-dos its orchestrator asked for (and, in a to-do's own Session, that to-do),
with live status. Its label shows an amber count while their approvals wait
on you, each counted once, the same approvals as the sidebar row's count and
the chat's cards.

- **The list** has the To-dos screen's status groups in the same order, then
  **Done this week** (closed in the last 7 days; older ones stay on the To-dos
  screen). Snoozed (with "next wakes …") and Done this week start folded. Each
  row has its status, T-n, title and age, then its reason and who works it; a
  to-do waiting on you shows its question with **Answer**. J/K or ↑/↓ move,
  ← folds, → opens a group, Enter opens. Under about 440 px the rows drop T-n
  and the worker.
- **+ New** opens New to-do. The new to-do is requested by you (the dialog has
  no requester choice), so it isn't one of the Session's own, but it opens in the
  tab once made. **↗** opens the To-dos screen grouped by Requested by, where
  this Session's to-dos sit under its name; the screen has no filter.
- **A to-do opens inside the tab**, under "‹ To-dos / T-14", with ↑ ↓ and ↗
  at the end of its bar. ↑/↓ (or J/K) step through the list; Esc or ‹ To-dos
  returns with the same row selected. ⌘-click (Ctrl-click) on a row opens it on
  the To-dos screen instead. Mark done is in ⋯ there, and ⌘\ stays the
  Session's Split Right.
- **Answer** opens the approval in the tab, in the same Decide view as the
  Session's approval column, under "‹ Back to To-dos". Sending it returns to
  the list; the count, the sidebar badge and the chat's card clear together. Esc
  goes back too, and so does answering it anywhere else. A question that arrives
  while the Session is shown still opens in the Session's approval column, over
  the split, as every Session's approvals do.

In the web app, an open Session's header has a **To-dos** button with the same
count. It opens that list full screen; a to-do opens on the phone's to-do
page, and back returns to the list, then the Session.

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
  "Waiting for the agent to finish its turn". When its tab was closed before
  the message went, or the tab won't start again after three tries, the
  thread says "Couldn't reach <tab>: …" and the message stays undelivered.
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

**A comment on a to-do that is Waiting on you is your answer.** It goes to
the orchestrator as usual, resuming it if it is down, and the to-do moves
again: a review is reopened (back to In progress, as Ask for changes would),
and its own waiting cards close with your words: the review card, a stuck
card, or its orchestrator's question (the agent gets your words as a message
in its tab). A sub-to-do's cards, and a reminder card, are left to be
answered themselves. A comment on a snoozed to-do is held until it wakes.

**Images.** An image you paste, drop or pick in a comment or reply shows
under its words as a thumbnail; other files show as chips. An image attached
to the to-do itself (a file dropped on the split or on the details'
Files, or an agent's `runpane todos attach T-n shot.png`) shows inline
too: its line never folds away. A file dropped anywhere on the thread goes to
the composer. Clicking a thumbnail opens the image in the split, fitted;
click it again for its actual size. Thumbnails show on the web app too, which
can't attach files.

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
   you. Asking again replaces the open review card, so only one waits.
2. You choose **Accept** or **Ask for changes**. Asking for changes sends your
   note back and returns the to-do to In progress. Commenting in the to-do's
   chat instead does the same, and closes the review card.
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

## Snoozing and reminders

A to-do can be **snoozed** until a time, with a wake-up note. While it is
snoozed it stays quiet: no reminders, restarts or stuck cards. At the time,
Pane wakes it.

**Snoozing it.** Press Z on its row or page, or use the page's header button
(it reads "Snoozed · Wed 9:00 AM ▾" while snoozed). The menu offers In an
hour, Tomorrow morning, Next Monday, or a date and time, each showing the time
it resolves to; then the note, and **Wake its agents** or **Just remind me**
(the default for a to-do with no Session). **Remind me…** in New to-do makes a
pure reminder: a to-do that isn't started and is snoozed from the start. An
agent snoozes from the CLI:

```bash
runpane todos snooze T-12 --until tomorrow --note "Check Sentry for new errors" --json
runpane todos snooze T-12 --until 2h --remind-me
runpane todos wake T-12
runpane todos list --status snoozed
```

Orchestrators are told to snooze to check something later (after a deploy,
or waiting on a reply) instead of waiting in a turn.

**Times** for `--until` are a small fixed set:

- ISO 8601, with or without an offset: `2026-11-18T09:00`,
  `2026-11-18 09:00-08:00`, `2026-11-18T17:00Z`.
- A date alone, meaning 9:00 AM that day: `2026-11-18`.
- A duration, optionally after "in": `45m`, `2h`, `3d`, `in 2h`.
- `tomorrow` or a weekday name (`monday`, `fri`), meaning the next one and
  never today, at 9:00 AM or at a time after it: `tomorrow 14:30`,
  `fri 10am`.

A time without an offset is read in the zone of the machine running the CLI,
and the instant is fixed before it is sent, so "9:00" means 9:00 where the
agent runs even when the to-do's host is elsewhere. The CLI prints it back
with its zone: "Snoozed T-14 until Wed 18 Nov 2026, 9:00 AM PST (in 17h). Its
agents stop after their current step." `--json` gives `snooze.until` as ISO
8601 with its offset, and `snooze.zone`. Errors say what to do next:

| Code | When |
| --- | --- |
| `todo_snooze_time` | Text the CLI can't read (the message lists the forms above), or a time more than a year away. |
| `todo_snooze_past` | A time that has already passed. |
| `todo_snooze_state` | A sub-to-do, or a to-do that is In review, Accepted, Done or Dropped; the message names what to do instead, such as snoozing its parent. |

**While it is snoozed**, its stored state is Stopped with a wake time, so the
supervisor, launch resume and the load gate leave it alone (and a Pane build
that doesn't know snoozing reads it as Stopped). If its agents were working,
Pane types the snooze message to the orchestrator after its current turn:
finish your step, tell workers to stop after theirs, then wait. It isn't typed
to the tab that ran the command. Agents may still comment, attach and check
done-when items as they finish; none of that wakes it. **Comments you write
while it is snoozed are held**: the thread shows "Held: goes to the
orchestrator with the wake-up note", and the composer's "Wake now and send"
wakes it and delivers them at once.

**At the time:**

- With a Session and Wake its agents, it goes back to In progress as a new
  episode (the supervisor's ladder starts again). Pane restarts the
  orchestrator and its assigned tabs in their same conversations if they are
  down, through the load gate and three at a time (a held one reads Queued,
  and Never pause is respected), then types the wake message:
  `[From Pane, To-dos] Reminder for T-12 "…" (snoozed until Wed 9:00 AM): <note>`,
  then the held comments and the attachments.
- With no Session, or Just remind me, Pane raises a **reminder card** linked
  to the to-do, and the to-do returns to the state it had before (To do stays
  To do). The card shows when it was due, how late, and the note, with
  **Done**, **Hand to an agent** (starts it as Start does, with the note in
  the orchestrator's first message), **Snooze 1 hour**, **Snooze to the next
  morning** (9:00 AM tomorrow in the zone it was set in, or Monday instead of
  a weekend day) and "Snooze to another time…", which opens the to-do with
  the menu. It is in Approvals and the floating strip like any card, covers
  the to-do's split, and opens full screen on the phone.

**Waking early.** Wake now, R on a snoozed row and `runpane todos wake` wake
it as its time arriving would: a Just remind me to-do raises its reminder card,
and one set to start its agents starts them. Start and Resume always start its
agents (through the load gate), even on a Just remind me to-do. The thread logs
who woke it.
Stop, Done and Drop clear the snooze (held comments stay in the thread,
undelivered). Snoozing it again changes the time and note.

**Missed wakes.** The wake check runs on the host's 2-second housekeeping
tick against the wall clock, with no timer per to-do, and only after launch
resume has run. A to-do whose time passed while Pane was closed or the Mac
slept wakes on the first tick after Pane runs again, and its event and
message say "overdue by 14h" (only a delay over 2 minutes counts). A clock
set forward wakes due to-dos early; one set back wakes them later. A to-do
wakes on its own host's clock, and a desktop that can't reach the host shows
"snoozed until … · machine offline" until it reconnects. Launch raises a
reminder card again if one went missing.

**Time zones.** The wake time is stored as an instant with the zone it was
set in. Every surface shows it in the viewer's zone; when that differs, the
tooltip says where it was set ("9:00 AM in Europe/London, where it was set").

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
| 30 minutes | Restarts the orchestrator in place: stops its agent and starts it again in its same conversation, then sends a third message saying so. While the load gate holds, the restart waits and the to-do reads Queued. If the agent doesn't start again, the thread says "Pane couldn't restart the orchestrator" and the card follows 10 minutes later. |
| 40 minutes, or 10 minutes after a restart with no progress | Raises a card linked to the to-do: "T-12 has been stuck for 40 minutes. The orchestrator was reminded twice and restarted once." with **Restart its agents**, **Stop it** and **I'll look**. The to-do reads Waiting on you and the ladder stops until you answer. |

An orchestrator whose process stopped, whose tab is gone, or that has been
busy without a turn for 5 minutes is restarted without waiting for 30
minutes.

| Limit | Value |
| --- | --- |
| Per stuck episode | 2 reminders and 1 restart, then a card to you. |
| Per machine | 12 reminders and 4 restarts an hour, attachment reminders and launch restarts included. Past either, the rest go straight to a card. |
| Repeat stalls | A to-do stuck 3 times in a day goes straight to a card at its next stall. |
| Never | While an agent in the Session is mid-turn, while you have unsent text in the orchestrator's tab, or while the to-do waits on you, is queued, is stopped or is snoozed. |
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
A queued start that fails (its agent won't launch, say) goes back in the
queue with the reason in its thread; after three failed tries it returns to
To do, saying why, for you to Start again.
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
| `[From Pane, To-dos]` | Pane itself: a new orchestrator's first message, a sub-to-do assignment, a reminder or restart, a pause for load, capacity back, an attachment reminder, a snooze or wake-up message, or an update for a requester. |
| `[From the person, via To-dos T-n]` | Your own words from the to-do's page: a chat message, Accept, Ask for changes, Stop, Resume or Drop. A chat message ends by telling the agent to answer with `runpane todos comment T-n "…"`, because a reply typed only in its tab never reaches the to-do's chat. |
| `[From <name>, via To-dos T-n]` | A reply in the to-do's chat from its requester or a worker, delivered to its orchestrator. |
| `[From To-dos T-n, asked by its orchestrator]` | A question for the requester, with how to answer it. |

## Storage

To-dos live in the host machine's `sessions.db`, in three tables added on
upgrade (`main/src/database/todosSchema.ts`):

- `todos`: one row per to-do, with its state, requester, assignee, the
  supervisor's and gate's counters, and while it is snoozed its wake time,
  zone, note, action, who snoozed it, the state it came from and its
  reminder card (seven nullable columns from `snoozed_until` to
  `reminder_card_id`, with an index on `snoozed_until`).
- `todo_attachments`: one row per attachment, with its kind, target, machine,
  who attached it and how (`attached`, `pr`, `approval` or `opened`).
- `todo_activity`: the chat's messages and events; `reply_to` names the row a
  reply answers.

Approvals gain a `todo_id` column. All of it is additive (`reply_to` is added
to databases from earlier to-do builds when they open), so an older Pane
opening the same database still starts. The snooze columns are added the same way. Done and dropped to-dos, their
attachments and activity are deleted 30 days after they close. A parent stays
while any of its sub-to-dos stays, so the family goes together once the last
of them is 30 days closed.

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
runpane todos list [--all] [--status waiting|working|queued|snoozed|idle|done|dropped]
runpane todos assign T-n [--panel <tab-id>]
runpane todos ask T-n "<question>"
runpane todos comment T-n "<text>" [--escalate]
runpane todos review T-n [--summary <text>] [--no-attachments "<why>"]
runpane todos done T-n [--person-said "<their words>"]
runpane todos drop T-n [--reason <text>]
runpane todos archive T-n
runpane todos start T-n
runpane todos stop T-n
runpane todos snooze T-n --until <time> [--note <text>] [--remind-me]
runpane todos wake T-n
```

- `update --done-when` replaces the list; lines that stay keep their checks.
  `--check` and `--uncheck` take 1-based line numbers.
- `list` shows open to-dos; `--all` adds those closed in the last 7 days.
  `--status` lists only those with that status; `--status snoozed` lists
  them soonest first. `show` prints a snoozed to-do's wake time, what
  happens then, who snoozed it and its note.
- `snooze` and `wake`: see [Snoozing and reminders](#snoozing-and-reminders).
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
`tests/todos.spec.ts`, `tests/todos-page.spec.ts` and
`tests/todos-snooze.spec.ts` (`playwright.chat-tabs.config.ts`). The page frame, the thread and the web
app also run on the renderer alone with fixture to-dos, in CI:
`tests/todos-page-frame.spec.ts`, `tests/todos-thread.spec.ts` and
`tests/remote-pwa-todos.spec.ts` (`playwright.ci.minimal.config.ts`). `tests/todos-real.spec.ts` runs real
Claude Code and Codex, only with `TODOS_REAL=1`.

The code is in `main/src/services/todos/`: `supervisorRules.ts` (the ladder
and limits), `loadGate.ts` (thresholds), `todoMessages.ts` (every line Pane
types), `todoService.ts` and `todoStore.ts`.
