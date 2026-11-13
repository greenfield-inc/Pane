# Approvals (Pane Notify)

Agents ask you questions through Pane instead of waiting in their terminal.
An agent calls the `notify` MCP tool (or `runpane notify`), Pane shows the
question wherever you are, even over your browser, and the agent gets your
answer as the tool's result. Inside Pane, everything that waits on you is in
**Approvals**, filed under the Session it belongs to. `notify` is the agents'
side of it, and keeps its name in the CLI, the MCP server and the code.

## What an agent can send

`notify` takes one `ui` value, which picks the card:

| `ui` | Card | Result |
| --- | --- | --- |
| `options` | The question and 1 to 9 `choices` (`{label, detail?, recommended?}`), or 2 to 4 `questions` (`{title, choices}`, one pick each) instead. The strip shows four, then **More**. | `{answer, note?}` (`answers[]` too for several questions), or `{reply, picks?, id, next}` when the person typed something ([Replies](#replies-and-new-versions)) |
| `approve` | Deny and Approve, plus a disclosure with the preformatted `detail`. `detailLabel` names the disclosure (up to 40 characters; default **Show details**). | `{approved, note?}` |
| `ask` | A text field, with optional `suggestions` as chips above it. | `{answer}` |
| `secret` | A masked field with **Save securely** and **Decline**. Created only by `runpane secrets request` (MCP `secrets_request`), never with `notify --ui`. The host saves the value as a [Pane secret](PANE_SECRETS.md) and drops it; it never reaches the agent, history or other screens. No Undo. | `{status: "saved", project, name}` or `{status: "declined"}` |
| `info` | One line, with at most one `action` button (`{label, url}`). It returns at once and hides after a few seconds. | `{delivered: "screen" \| "inbox"}` |

Every card takes a `title` (one line on the strip, wrapping to three) and an
optional `context` shown under **Details** and in the round. A `context` that
is a status file or a `needs_you` block, as JSON, never shows raw: Pane shows
its question and `why`, adds its `files` as links, and turns an `ask` with no
`suggestions` into an `options` card with the question's `options` as choices;
other JSON shows one `summary`, `step` or `title` line, or none. On `--update`
the new context is read the same way, but the card keeps its `ui`, and its
choices and links unless the update passes them. Prose stays as written, even
when it starts with `[` or `{`. Any card also
takes up to 6 `links` (`--links`), related files and pages shown as chips:
`{label, path}` for a file on the asking machine (relative to its working
directory), `{label, url}` for an http or https page, or `{label, approval}`
for another approval (its id or Q-n). Older Panes ignore them.
In Approvals, clicking a chip opens it as a tab beside the card: a file in an
editor tab, a page in a browser tab, another approval in place, with **Back**.

Pane builds each approval's **Summary** from these fields (D-225), unless the
asker linked its own `.html` Summary page (a worker's `--summary-file`, or
`summary` in its `needs_you`). Agents write a card to read on its own: a
one-line title of about 80 to 100 characters, `context` of one or two sentences
on why it matters (up to 240 characters), 2 to 4 choices each with what it does
(`detail`) and exactly one `recommended`, and links to every reference: files,
PRs and other approvals. Every way of asking goes through one check
(`main/src/services/notify/cardCheck.ts`): Pane refuses a title over 160
characters or with a line break, and two recommended options in one question,
and returns a warning for each softer miss, which `runpane notify` and
`runpane report` print. An old paragraph card (the whole question in its title,
with no buttons) is first split by fixed rules into a title, options and
links (`cardTidy.ts`); the card reads "Tidied by Pane" and **Show as sent**
shows what the agent sent.

**Which card.** Pane's approvals text (`main/src/services/approvalsRules.ts`,
"Asking the person in Pane") is the one rule every Pane text carries: Claude's
own card (AskUserQuestion) only for a quick question that answers the person's
latest message in the chat they are typing in and only steers that turn;
everything else, including any worker's question in a Session, is an approval
card. Codex and other agents without a built-in card always use an approval.
`main/src/services/approvalsRules.test.ts` fails when a copy drifts.

When Approvals is off or Pane isn't running, the result is
`{unavailable, next}` ("Approvals are off in Pane.") and the agent asks in its
terminal as it does today.
For an API key, token or password, agents call `secrets_request` (or
`runpane secrets request`), never `ask`. When that returns `unavailable`, the
agent asks you to save the secret in Pane under Settings > Secrets.

```sh
runpane notify --ui options --title "Which session store should the refactor use?" \
  --choices '[{"label":"Postgres table","recommended":true},{"label":"Keep Redis"}]' \
  --links '[{"label":"Plan","path":"docs/plan.html"},{"label":"PR #12","url":"https://github.com/acme/app/pull/12"},{"label":"Q-12","approval":"Q-12"}]'

# Several questions in one card
runpane notify --ui options --title "Q-20: How should the release train start?" \
  --questions '[{"title":"Turn it on now?","choices":[{"label":"Yes, turn it on","recommended":true},{"label":"Not yet"}]},{"title":"How many trains?","choices":[{"label":"One train","recommended":true},{"label":"Two trains"}]}]'
```

## Who asks: Sessions

Pane files each item under the Session its Pane belongs to (a Session's own
orchestrator tab is marked as the orchestrator). Items from a Pane in no
Session go under "Not in a Session". Items Autopilot asks itself go under
"Autopilot", marked "written by Autopilot" ([AUTOPILOT.md](AUTOPILOT.md)).

- **Workers in a Session don't call `notify`.** Approvals come from the
  Session's orchestrator, not from the agents in its Panes. A worker reports
  blocked to its orchestrator (`runpane report --state blocked --question
  "<question>"`). That question is a card at once, with an answer box, and it
  rings once the orchestrator relays it or after 10 minutes, so the orchestrator
  first settles what the plan already answers. Your answer goes straight to the
  worker's tab (`answer: Q-n → <answer> (by you)`), even with the orchestrator
  down. A typed reply goes there too (`reply: Q-n → …`), and to the
  orchestrator that relayed it when the worker can't read it
  ([Replies](#replies-and-new-versions)). A worker's `notify` call isn't shown: it returns `unavailable`, "Not shown to the
  person: in a Pane Session, only the orchestrator asks the person.", with a
  `next` that says to report blocked. Claude's own permission and plan
  prompts and a chat tab's prompts on a worker tab are the tool asking, so
  they still reach you, filed under the Session.
- **A Session orchestrator** keeps every item that waits on you posted to
  Approvals exactly once, titled with its Q-n and with the worker's files as
  links. It relays a worker's question into that card (`runpane notify --relays
  <item> ...`), which gains choices, context and links, then records the decision
  (`runpane inbox ack <item> --decision <D-n>`), and the card reads "Recorded as
  D-n". It posts its own items with `runpane notify ... --json`. Both run as
  background commands, so it stays free to talk: you can ask it about an item in
  its own tab while the card waits. The
  full rule is in the orchestrator guide
  (`runpane docs read --doc skills/pane-orchestration/SKILL.md`, "What waits
  on the person"). A second card from an orchestrator on the older rules keeps
  working for one release.
- **Autopilot** asks with `notify` too, and can answer, close and rewrite items
  within its rules ([AUTOPILOT.md](AUTOPILOT.md)).
- **Any other agent** calls `notify` as before.

Claude's permission prompts and chat tab prompts (below) still come straight
from the asking tab, filed under its Session.

## Claude's own prompts

Claude tabs Pane starts also ask their permission and plan prompts in Approvals,
without the agent calling `notify`. The terminal shows the prompt as usual;
the first answer from the terminal, Approvals, the strip or the phone wins.

- **Desktop Approvals** shows Claude's choices: Yes, each "Yes, and don't ask
  again for …" or "Yes, and allow access to …" that Claude suggests, and No.
  A note on No tells Claude what to do instead; without one, Claude stops and
  waits, as No does in the terminal. A plan shows its text with "Yes, and
  auto-accept edits", "Yes, and manually approve edits" and "No, keep
  planning".
- **The phone** lists the prompt in Approvals with **Yes** and
  **No**, and its alert carries the same two buttons. The question's sheet has
  every choice.
- **Answered in the terminal**: Pane closes the question and lists it in
  Done today as "Answered in the terminal".
- **The whole command, plan or tool input** is on the card, so Yes never
  approves something you couldn't read. One over 32,000 characters is too long
  to show: its question offers no choices and says to answer in the terminal.
- **After 10 minutes** Claude stops waiting on Pane. The question stays, says
  "Claude is asking in the terminal now" with **Open**, and loses its choices;
  answering in the terminal clears it. An answer still in its 3-second Undo
  hold then never reaches Claude, so it is dropped the same way.
- **The first prompt** after an update adds a one-time note to Approvals.

How it works: each Claude launch gets an http `PermissionRequest` hook aimed
at a loopback endpoint on the machine running it, with a token for that tab.
Claude reads only the last `--settings` flag, so Pane writes one settings file
per tab (owner-only, in `claude-prompts` under Pane's data folder) that merges
its hooks with any `--settings` the command already passes, and launches with
that file instead. The file is written with this setting off too, for the
`SessionStart` hook that tells Pane which conversation the tab is on
([CHAT_TABS.md](CHAT_TABS.md#switching-a-terminal-tab-to-chat)). A command whose `--settings` Pane can't read, or a tab
whose settings file Pane can't write, launches unchanged. Wrapped launches, commands that don't start with `claude`, SSH tabs
and WSL tabs keep their command, and their prompts stay in the terminal.

Turn it off in **Settings → AI & Agents → Answer prompts from Pane**. Off
takes effect at once; a tab started while it was off picks it up when it
restarts.

## Chat tab prompts

[Chat tabs](CHAT_TABS.md) send their ACP approvals to Approvals too, with exactly
the choices the adapter sent (the phone's Yes and No are its allow and reject
choices). A question (ACP form) is asked one field at a time, titled "(1 of 3)"
with the field's title when it has more than one: single choice and yes/no as
options, multiple choice as free text naming the choices (comma-separated, with
each choice as a chip), text and numbers as free text. A typed answer to a
choice fills the form's matching free-text field (AskUserQuestion's
`question_0_custom`). The last field sends the whole form as one answer; "Skip
question" declines it. The first answer wins: an answer from Approvals reaches
the agent, and a card the chat tab answered first closes as "Answered in the
chat", along with the rest of its form. In Approvals the card shows beside the
chat tab, which docks the same prompt above its composer.
**Settings → AI & Agents → Answer prompts from Pane** turns this off too. A chat tab waiting on a prompt reports
`blocked`, so phone alerts follow it like a terminal agent's.

## Long waits

A question waits until you answer it. How the call stays open depends on the
client:

- **Claude Code and Codex** wait in one call. Claude Code moves a call that
  runs past about 2 minutes into a background task and ends its turn; your
  answer still reaches the agent when you send it. Pane's MCP server sends a
  progress notification every minute, and Pane registers the server with
  Codex using a 24-hour tool timeout.
- **Cursor's CLI** ends every tool call after 60 seconds. About every 50
  seconds `notify` returns `{waiting: true, id, next}`, and the agent calls
  `notify` again with `resume: <id>`. The card doesn't change. After 15
  minutes without an answer the call returns `unavailable`. Cursor asks
  "Run this MCP tool?" before every call, resumes included; pick **Allowlist
  MCP Tool** once so a waiting agent doesn't stop at that prompt.

If the agent stops waiting (you interrupt it, it exits, or its call times out)
and doesn't resume within 30 seconds, the item closes ("closed: the asker stopped
waiting"; see [When an approval goes away](#when-an-approval-goes-away)). Codex 0.164 doesn't tell Pane when you press Esc, so a question from a
Codex panel also closes when that panel sits idle at its prompt for 10 seconds.

## Where questions show

- **Inside Pane: Approvals.** An **Approvals** row in the sidebar's top list,
  below Loops (directly below Autopilot when Autopilot is on), shows an amber count of the items waiting (none at zero);
  clicking it, or pressing ⌃⇧Space while Pane is in front, opens the Approvals
  screen in the main area, and clicking the row again returns you to the view
  you left. The sidebar keeps the Sessions list,
  Panes with a waiting item show an amber "Waiting", and each Session row
  shows an amber count of the approvals waiting from it. The row's count is the sum of every Session's count plus items not in a
  Session, across saved machines; in the one-machine sidebar its tooltip says
  how many of them wait on other machines. Beside
  it, the queue has **Waiting** and **Done today** tabs and a **Group by** menu,
  remembered per device: **Most recent** (the default) lists items flat, newest
  first, each row naming its Session and machine; **By Session** and **By
  project** group them, each group placed by its newest item; **Sidebar order**
  groups by Session in the order the sidebar shows them (the All machines
  arrangement when that's on), following a drag there, with Sessions the
  sidebar doesn't show last, newest first. Each group is boxed under a header
  with its name, machine mark and waiting count. Waiting sorts by when it was asked and Done today by when it was
  answered. A new item never moves the selection or the selected row. The
  list stays compact rows, each with a chip for "Reading your reply…",
  "Getting more context…" or "Updated · ready again". The selected item opens
  in **the approval column** beside the list (see below); its pager follows
  the list as grouped. The column's last tab is the chat where it was asked,
  live: an orchestrator's item shows the Session's orchestrator tab, so you
  can ask it about the item in its own composer; a worker's prompt or a
  standalone item shows the asking Pane's tabs, with **Open in Pane** (or
  **Open on <machine>** for another machine's item). Below about 1,100px wide,
  the list stacks above the column. After a pick, the column shows "Sent:
  …" with **Undo** for 3 seconds; the item then moves to **Done today**,
  which lists the last 24 hours, updates (`ui info`) included. Under Most
  recent, once a typed reply is with an agent, Waiting splits into **Waiting
  on you** and **With the agent**, each row naming who reads the reply. Inside Pane there is no
  floating strip and no Notify row in the sidebar.
- **The approval column**: one tabbed column for an approval, the same on
  every surface. Its header pages through what's waiting (‹ n of N ›, dots, ←
  and → while it has focus) and ✕ closes it. Its tabs are **Decide** (the
  subtitle, each question with its why and options, recommended ones
  pre-selected, the references and one reply box that grows up to half the
  column), **Summary** (one HTML page: the asker's own, an `.html` passed as a
  worker's `--summary-file` or `summary` in `needs_you`, else one Pane writes
  from the card and the worker's status file; it renders with scripts and
  network off, the same on the Mac, from another machine and on the phone),
  each linked file (in the document viewer), URL (in the
  in-app browser) or other approval (in place, with Back), and the chat where
  it was asked, left out when you're already in it. In a **Session**, the
  column lays over the Session's right split view without resizing it, and ✕
  ("Back to <tab>") shows the split again as it was; with no split open it
  opens a split of its own, and ✕ ("Close split") collapses it. There it is a
  focus stop of its own: Focus Right (⌘⌥→) and F6 move into it from the chat,
  the tab keys (⌘⇧[ ⌘⇧], ⌘⇧1-9) walk its tabs while it has focus, Focus Left
  or Esc go back to the chat's message box, and its active tab carries the
  accent only while it has focus, as a split's does. The right
  sidebar (Overview, Files, Changes) is never covered. The Session's title
  bar shows **Approvals n · n ready**, and a Session row's count in the
  sidebar opens the newest ready-again approval, or the first waiting one. A
  Session's orchestrator chat docks one compact card above its composer:
  who asks, the title and subtitle across the card, and a bottom row with ‹ n
  of m ›, the reference count, Summary and **Open**; its pager stays in step
  with the column's. The chat's own AskUserQuestion isn't docked: the chat
  already shows Claude's card, and Approvals and the phone keep the copy.
  **Send** closes the column, and a status line in the chat names the agent
  reading the reply ("okta-sso-account is reading your reply to Q-42"), then
  how it was taken, with **Reopen**. "Taken as your answer" shows only on that
  approval, its row and that line. The card open in the column has a darker
  grey outline and an **open** label. In **Autopilot**, the column covers the Stack (✕ "Back to the
  Stack"), and Autopilot's decision cards gain **Open**. In a Session and in
  Autopilot, the chat tab is live too: an orchestrator's item shows its
  Session, and a worker's or a Pane's item shows the tab that asked.
- **The strip**: while Pane isn't in front, a borderless card at the bottom
  center of the screen with the pointer. It never takes keyboard focus when it
  appears; click a choice to answer, or click its text field to type. After
  you answer, it shows "Sent to <agent>" with **Undo** for 3 seconds before
  the agent gets it. Only one strip is ever on screen, oldest question first.
  **Open in Pane** brings Pane to the front on Approvals with that item
  selected.
- **The round**: press ⌃⇧Space (Ctrl+Shift+Space on Windows and Linux) from
  any other app for a centered panel that works through the queue by
  keyboard: number keys or arrows choose, ↵ sends, → skips, Tab adds a note,
  Esc closes.
- **The menu bar or tray icon** shows an amber dot while questions wait. Its
  menu lists them and holds Show outside Pane, Pause for 1 hour, a way into
  Approvals, and its settings.

**Keys on a card.** With the pointer over a card in Approvals, its keys work:
a choice's number answers it, Y approves, N starts a denial, and typing starts
an ask's answer. Keys typed into a field (a terminal, a chat composer, a search
box) stay there, even with the pointer over a card. The floating strip over
another app takes keys once you click it, so typing in that app never answers
by accident. Keys work whatever Pane's keyboard-shortcuts setting says. On
Approvals, **More** (or **Details**, when choices have notes) opens the card in
place with every choice, its note and **Send**.

✕ hides a question from the strip; it keeps waiting in Approvals.
Right-click ✕ to bring it back in 10 minutes, in 1 hour, or when you next
switch to Pane. The clock at the bottom right of a card snoozes it for 3, 5
or 15 minutes: it leaves the strip, then comes back in its place in the
queue, and Approvals shows it with its return time. The agent keeps
waiting through a snooze or reminder.

## Where approvals are kept

Each machine keeps one saved list: the `approvals` table in its `sessions.db`,
one row per item from any origin (`main/src/services/approvals/approvalStore.ts`).
Orchestrators, workers (through a blocked report), Autopilot, Claude prompts and
Pane itself all post to it. An approval lives on the machine where its creator
runs; devices read and answer it over the connection they already use, and
nothing is copied (D-145, D-165). Open calls, the 3-second Undo hold and the
alert timers stay in memory beside the table.

An item survives a restart, and an answer reaches its asker whether or not its
call is still open: an open call returns it, and otherwise Pane types `answer:
Q-n → <answer> (by you)` into the asking tab once, when its agent is idle at
its prompt and in the terminal's foreground process group. A wrapper and the
agent it started share that group, so an agent-farm worker (`node
telemetry.mjs` running `claude`) qualifies. A shell, a nested shell, `ssh` or a
REPL there keeps the answer owed, and the card reads "not delivered to <tab>
yet" until it goes. Where Pane can't see what runs in the tab (Windows, WSL and
the PTY host), or the tab closed, the answer is never typed: the card reads
"not delivered to <tab>: <why>" with Copy answer, and `runpane inbox` lists it
as `undelivered`. The orchestrator passes on one Pane couldn't see to type; one
whose tab closed has no one left to tell. An
asker that posts the same question again from the same tab (same Q-n or title)
joins the waiting card instead of adding one.

On a machine's first start with this table, a one-time import moves
`session-inbox.json` into it (`main/src/database/jsonStoreImport.ts`). It takes a
backup first (`session-inbox.json.before-import`), runs in one transaction with a
marker, and is safe to interrupt. The original file stays in place. If the import
fails, Approvals says why, nothing is deleted, new approvals still work, and it
retries on the next start.

## Replies and new versions

An approval has one reply box. Picks alone are an answer, as before: the call
returns `{answer}`, or Pane types `answer: Q-20 → Yes, turn it on · One train
(by you)`. Anything typed is a **reply**, which may be an answer or a question
about the approval. Pane doesn't decide which; the agent that reads it does
(D-245, D-258).

**The lines.** The reader's open call returns `{reply, picks?, id, replyId,
next}`. Only that call is given `replyId`: it is private to the call, kept
apart from the reply's own id, and in no snapshot, history or other screen. So
passing it to `--took` and `--update` proves the caller is the reader, from a
Pane tab or a terminal outside Pane alike (D-294). With no open call, Pane types into the reader's
tab, once, by the same rule as an answer:

```text
reply: Q-20 → "Turn it on only if it can be undone" (picked: Yes, turn it on · One train) (by you)
correction: Q-20 → that was a question: "…" (by you)
correction: Q-20 → that was your answer: "…" (by you)
```

`(picked: …)` is there only when something was picked. Picks keep their
question's place: one left unpicked reads `—` (`picked: — · One train`), and
the result's `picks` holds `''` there. Without a Q-n the line names the title
in quotes, and adds `[id <item id>]` before `(by you)`. Each reply has an id
and is delivered once.

One reply at a time: while its reader is reading a reply (it has the line but
hasn't run `--took`), a second typed reply is refused, with your words left in
the box; picks still answer. A reply still waiting for a busy tab is replaced
by a newer one, and only the newer line is typed. The same rule holds on every
surface: the floating strip and the round send anything typed as a reply too,
except on a permission prompt, whose note stays a note.

**Who reads a reply**, in order:

1. The asker: its open call, else its tab (a busy tab gets it when it's next
   idle).
2. For a worker's question an orchestrator relayed, that orchestrator's tab.
3. Autopilot, when it's on, in its chat tab.
4. None: the approval reads "No agent can read replies right now. You can
   still pick an option." The reply stays unread, and picks still answer.

A reader that turns out gone passes the reply to the next one. A reply the
asker or orchestrator hasn't taken after 10 minutes goes to Autopilot when
Autopilot is on.

**What the reader runs.** Only the reader may; anyone else gets
`ERR_NOTIFY_NOT_READER` with a `next`. A worker in a Session may run both:
they aren't new asks.

```sh
runpane notify --took Q-20 answer      # records the reply (picks and text) as the answer
runpane notify --took Q-20 question    # "Getting more context…" (--status "<text>" to say otherwise)
runpane notify --update Q-20 --asked "Can it be undone?" \
  --what-changed "Added the undo path to the context" \
  --context "<new context>" --choices '[{"label":"Yes, with undo","was":"Yes, turn it on","recommended":true},{"label":"Not yet"}]'
```

`--took` and `--update` take an item id or Q-n and no `--ui`. `--update` needs
`--asked` (the person's question) and `--what-changed` (one line per change),
and replaces whichever of `--title`, `--context`, `--choices`, `--questions`
and `--links` it passes. A reworded choice carries `"was"`, its old label.
`--update` then waits for the answer like any notify call (`waiting`,
`unavailable` and `--return-after` work the same). It never adds a second
approval.

**Versions.** Each `--update` saves a new version on the same item: the
question asked, What changed, who changed it and when. An item keeps at most 10
versions; older ones fold into the oldest. They live in the item's saved JSON,
so older items simply have none.

**What the approval shows:**

| State | Shows |
| --- | --- |
| Waiting, no reply | Waiting |
| Reply delivered, not yet taken | "<reader> is reading your reply…", naming the reader for every kind ("okta-sso-account", "The Doozy orchestrator", "Autopilot") |
| Taken as an answer | "Taken as your answer", with **It was a question** |
| Taken as a question | "Taken as a question: <reader> is getting more context", with its status when the reader gave one, and **It was my answer** |
| Updated | "Updated · ready again": your question quoted ("You asked"), What changed and by whom, choices marked NEW, REWORDED (the old label struck) or REMOVED, and a collapsed **Earlier version** |
| No reader | "No agent can read replies right now. You can still pick an option." |
| A chat tab's built-in question | "Sent to <agent>": the typed reply is its answer, so there is no fix |
| A chat tab's built-in question that takes only its choices | No reply box: pick one of its options |
| Answered | Answered |

The fix is one click. **It was a question** sends the reader `correction: Q-n →
that was a question: "…"`, and the reader updates the approval. **It was my answer**
records the reply as the answer and sends `correction: Q-n → that was your
answer: "…"`, and the reader acts on it. The pager skips items whose reply is
being read or asked about. Permission prompts stay options only, with no reply
box.

## When an approval goes away

An approval exists only while you can act on it and someone can take the answer
(D-147). The machine that owns it decides.

| Situation | What happens |
| --- | --- |
| Its Session is closed or archived | Closes within 5 s: "closed: Session closed", "closed: Session archived". |
| Its asker is gone: its Pane archived or deleted, its tab closed, the worker sent a newer report, or a `notify` caller stopped waiting | Closes within 5 s of Pane learning it, with the reason: "closed: the asking tab was closed", "closed: the worker moved on", "closed: the asker stopped waiting". A sweep every 60 seconds catches anything missed. One exception: when only its tab closed and the orchestrator that relayed it, or Autopilot, can still read a reply for it, it stays open. |
| Pane restarts | Items whose asking tab still exists stay waiting. |
| Unanswered for 3 days | Stale: moved to a collapsed **Stale** group at the bottom of Waiting. It never rings or pushes again. |
| You close one | One action on any card, with an optional reason. Its asker's open call returns "The person closed this question.", or `closed: Q-n (by you)` is typed into its tab. **Reopen** puts it back. |
| You or Autopilot answered | Done today lists it for 24 hours. |

The store keeps answered and closed items 7 days for the record and for
orchestrators catching up on decisions (`runpane inbox`), then drops them. On the
first start of a build with this table, a one-time cleanup closes every item
whose asker is gone ("closed on upgrade: <reason>"), and one summary card lists
what's left, oldest first, with **Close all** and **Keep**.

## Who asked, who acted

Every card names where it came from: "workos-sso in Sales Skill · Mac mini". This
machine's own items use its name from the machine picker, or no machine at all.
Every item is connected to its Session; outside one, to its Pane, or for
Autopilot's own items to the Session it's about or Autopilot's chat. Opening it
shows that, with its related files and documents.

What happened to an item stays on it, on every device: "Answered by Autopilot ·
because D-22", "Closed by Autopilot: Session archived", "Closed: Session archived",
"Rewritten by Autopilot from Q-7", "Recorded as D-147". **Override** on an answer
from Autopilot sends your answer to the asker as a correction (`correction: Q-n →
<answer> (by you)`), recorded on the item. **Reopen** undoes a close by you or by
Autopilot.

## Alerts

Alerts interrupt you on the device you're using (D-144):

- **A computer rings** (the strip and the chime) only if it was used in the last
  2 minutes with its screen unlocked, for its own items and other machines'. If
  two computers are both in use, both ring. In-Pane cards still show while Pane
  is in front.
- **The phone** gets a push about 90 seconds after an approval arrives, only if
  it is still waiting. Answering it, closing it or turning Approvals off cancels
  the push.
- A worker's question rings once its orchestrator relays it or after 10 minutes.
- **An updated approval is quiet** (D-244): "Updated · ready again" shows as a
  notice on the computer in use, with no chime, plus its badges and counts. The
  phone gets a push only when no computer is in use. You started the follow-up,
  so it doesn't ring like a new approval.
- A computer can ring only for machines it has saved. Autopilot's "Can't see"
  shows that gap, and the phone push still arrives.
- **Show cards on** (Settings → Approvals) moves the strip, its window over
  other apps and the chime to one computer, for every machine it has saved.
  That computer still rings only while it's in use; when it's idle or locked
  the phone push is the backstop. Every other computer stays quiet while the
  picked one reads it, and keeps its Approvals list, counts, tray dot and
  answer-all shortcut. A computer the picked one can't read (it's off, asleep
  or disconnected, or it hasn't saved this computer) rings as if nothing were
  picked, and its Settings row says why. "Reading" means the picked computer
  holds a live connection to this one, as its owner or a paired device, naming
  itself by its install id (`machineId` in `config.json`; a `config.json`
  copied to another computer carries the same id, so delete the key there).
  A computer that has saved the picked one also checks its own connection:
  once that drops (about 20 seconds after the picked one sleeps or leaves the
  network), it alerts again. A computer closes its connections before it
  sleeps. The Settings row reads one of:
  - "Cards pop up on <name>. They're still listed here.": the picked computer
    reads this one, so this one stays quiet.
  - "<name> hasn't added this computer, so this computer's cards still pop up
    here.": this computer has saved the picked one and has seen it online for
    over a minute, but it doesn't read this one.
  - "<name> isn't connected, so cards pop up here for now.": anything else,
    such as off, asleep, just restarted, or not saved here.

## Other screens and your phone

The machine running the agent keeps the one queue. Every screen connected to
it shows its questions, and the first answer from any of them goes back to
the agent:

- **A Pane desktop with saved machines** (Remote Access pairing or
  Workspaces) shows every saved machine's questions beside its own, whichever
  machine it is on: the strip over other apps, the round, the tray dot, the
  chime, Approvals, its sidebar count and the Waiting dots, within the
  [Alerts](#alerts) rules. Each card names its machine, and Approvals shows the
  machine's mark in its Session's group; beside it are that machine's Session
  name and linked documents, read from that machine, and **Open on <machine>**,
  which switches to that host instead of mounting a live Session view. A document
  that can't load is one line ("<doc> isn't on the Mac mini anymore", "Couldn't
  reach the Mac mini"), and the card stays answerable. An answer, Undo, ✕, snooze or → goes to the card's own
  machine and clears there; nothing switches. Open in Pane shows on this
  computer's cards and on the machine the desktop is on, where it opens the
  host's Pane in this window and leaves the host's own window where it is.
- **Several screens at once**: the screen you answer on says "Sent to
  <agent>", every other one says "Answered on <device>", and all of them offer
  **Undo** for the 3 seconds before the agent gets the answer. ✕, snooze, the
  reminders and → in the round apply on every screen, except "When I switch to
  Pane", which waits for the Pane you used it on.
- **Connection loss**: a machine that can't be reached collapses to one row,
  "Mac mini offline · 4 waiting · they come back when the Mac mini is online",
  since its cards can't be answered; the agents keep waiting. After reconnecting
  the screen shows what is waiting there now. Autopilot says "<machine> offline".
- **Your phone**: the Pane app lists Approvals with the same sort menu, and an
  item opens above its Session's tabs and chat. A question still waiting after
  about 90 seconds sends one alert to every phone signed
  in to the host in the Pane app with notifications allowed and **Needs
  Input** on. The alert is titled with the Pane's name and says only "<Pane>
  has a question" (the folder name for a call from outside Pane); updates
  (`info`) send none. When the question is answered elsewhere or its agent
  stops waiting, the host sends a silent update so the phone can remove the
  alert, and an Undo makes it alert again. The host needs its usual phone
  credentials (`PANE_APNS_*` or the shared ones for iPhone, FCM for Android;
  see [NATIVE_MOBILE.md](NATIVE_MOBILE.md)); without them nothing is sent and
  the question still waits on every screen.
- **A headless host** (`runpane install daemon`, remote setup, workspace
  hosts) has no screen of its own: it creates no strip window, tray icon or
  shortcut, and its questions show on every desktop that has it saved and on
  the phone. With none of them running, a question waits until one connects
  or answers.
  An update from it returns `delivered: "inbox"`; connected screens still show
  it on their strips.

Each screen keeps its own Position, Show outside Pane, Sound, Show details, answer-all
shortcut and Pause. The Approvals switch decides whether agents can ask, and it
is one switch across your machines: turning it off returns `unavailable` to every
waiting agent on each machine and clears its questions from every screen. Show
cards on is shared the same way.

## Settings

**Settings → Approvals** (the setting is still saved as `notify.enabled`):

| Setting | Default |
| --- | --- |
| Approvals | On. Off hides the sidebar's Approvals row, expires open cards, returns `unavailable` ("Approvals are off in Pane.") to every waiting agent. Agents, Session orchestrators included, then ask in their own tab. Applies to all your machines ([how the switch travels](SHARED_CREDENTIALS.md#the-approvals-switch)). |
| Show cards on | Whichever computer is in use. Or this computer, or a saved machine that has connected since Pane started: only that computer pops up cards and chimes ([Alerts](#alerts)). Applies to all your machines, saved as `notify.cardsOn`. |
| Show outside Pane | On. It controls the floating cards over other apps. Off shows no floating card; inside Pane you answer from the Approvals row and screen, and the tray dot still shows. |
| Position | Bottom center. Also top right or bottom right. |
| Answer-all shortcut | ⌃⇧Space. Settings says so when another app already holds it. |
| Updates hide after | 6 seconds |
| Sound | On, for questions only |
| Show details | Off. Cards open with details shown when on. Showing or hiding details on a card changes it. |

Only the Approvals switch and Show cards on are shared; the other settings here stay on each machine.

Pause for 1 hour (tray menu) hides strips and mutes sound while questions keep
queueing. Strips show over full-screen apps, during screen sharing, and with
Focus or Do Not Disturb on; Pause is the way to quiet them.

## What Pane tells agents

While Approvals is on, Pane keeps a short block in each agent's user-level
instruction file, so every agent knows Pane is there and asks through `notify`:

- Claude Code: `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`)
- Codex: `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`). Agent Farm's
  Codex launches use a generated `CODEX_HOME` that links this file, so they
  read it too.
- On Windows, the same two files in the home of each WSL distro a project
  runs in (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` as that distro's login shell
  sets them). Pane writes them at launch and when you change the settings
  below; a distro that doesn't answer is shown as skipped and tried again at
  the next launch.

The block sits between `<!-- pane-notify:begin ... -->` and
`<!-- pane-notify:end -->`. Pane writes it at first launch, since Approvals is
on by default. It has two parts:

- **Pane:** when `PANE_SESSION_ID` is set, the agent is in a Pane terminal
  and should load the `pane` skill before using Pane. With the skill turned
  off (Settings → AI & Agents → Install Pane skill for agents), it points at
  `runpane agent-context --json` instead. If `runpane` isn't on `PATH`, the agent runs `$PANE_RUNPANE_BIN`
  (PowerShell: `& $env:PANE_RUNPANE_BIN`), or else the installed Pane's shim:
  `~/.pane/bin/runpane` on macOS and Linux,
  `C:/Users/<you>/.pane/bin/runpane.cmd` on Windows (forward slashes, so
  PowerShell, cmd and Git Bash all run it), and
  `/mnt/c/Users/<you>/.pane/bin/runpane` in WSL. The path is always the
  default data folder's, so a dev build with its own `PANE_DIR` never points
  your agents at its copy.
- **Pane Notify:** call the `pane` MCP's `notify`, or `runpane notify` when
  that tool isn't loaded (for example under Agent Farm's strict MCP mode).
  It says who asks (in a Session, a worker reports blocked instead of calling
  `notify` and gets the answer in its tab, and the orchestrator posts in the
  background; any other agent calls `notify`), when to ask (only what the
  agent can't find out itself, related questions in one card, `info` rarely)
  and how to write a card for someone who has lost the thread: what the work
  is for, what just happened, and what is needed. It also says how to read a
  typed reply: `--took` it as an answer or a question, and answer a question
  with `--update`, never a second approval.

Pane writes only those lines, plus a line
break before them when the file didn't end with one; the rest of the file keeps
every byte. It creates the file only when the agent's config folder exists and
never deletes it. It leaves alone a file that is a symlink or not a regular
file, isn't UTF-8, or has a stray marker, and one that another program keeps
saving while Pane writes. Settings → Approvals → Agent instructions shows each
file's state.

To remove the block, turn Approvals off in Settings → Approvals. Pane writes it
again when you turn Approvals back on, or at the next launch with Approvals on.

The `pane` MCP server's instructions carry the same rules, plus good and bad
example cards; that is how Cursor learns them.

## Linking a call to its Pane

Pane sets `PANE_SESSION_ID` and `PANE_PANEL_ID` in every terminal it opens.
Claude Code passes them to MCP servers; Pane's registration forwards them for
Codex (`env_vars`) and Cursor (`${env:NAME}`). A call from an agent outside
Pane still works: its card shows the folder name and hides Open in Pane.

## Platforms

macOS, Windows and Linux on X11 show the strip over other apps. In a Wayland
session Pane runs as a native Wayland app and can't place a window over other
apps, so Show outside Pane is unavailable there (in Settings and the tray menu).
Questions show in Approvals inside Pane, with its sidebar count, Waiting dots and
the chime. The tray icon and its dot work; GNOME needs the AppIndicator
extension, which Ubuntu turns on by default. On GNOME 46 (Ubuntu 24.04), which
has no global-shortcut portal, ⌃⇧Space doesn't reach Pane from other apps;
inside Pane it opens Approvals.

The code: `main/src/services/notify/` (queue, windows, tray),
`main/src/services/approvals/approvalStore.ts` (the store),
`main/src/ipc/notify.ts` (including the `notify:remote-snapshot` and
`notify:remote-command` commands and the `notify:shared-changed` event other
screens use), `main/src/daemon/mobilePushSender.ts` (the phone alert),
`shared/types/notify.ts`, the renderer's Approvals screen
(`frontend/src/components/approvals/`) and Notify card components, and the
`frontend/notify.html` entry for the floating windows.
