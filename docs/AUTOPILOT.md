# Autopilot (experimental)

Autopilot is one always-running agent above every Session on a machine. Press
Start and it analyzes everything first: every Session (open, running, idle,
old), its Panes, workers and PRs, and every waiting item on every machine. It
plans the order (unblock running work first, then keep active work moving,
then propose closing what is stale), groups the work into a few
**workstreams** by Session, repo or feature with their approvals together,
writes the plan to `docs/plan.html`, and walks it. It puts each item on a
**stack** beside its chat, one at a time, with the item's documents and app as
tabs.

**It drives the conversation (D-146).** Every Autopilot turn ends with the
next step it is taking or proposing; it never stops at "I'll wait for you".
While the person hasn't answered, it carries on with what doesn't need them.
If its agent sits idle for 3 minutes while it runs (not paused, Sentinel off),
Pane wakes it with a hidden `[Pane · Carry on]` line, at most 3 times in a row
until the person or an event starts a turn. Pause stops the driving until Go
on; turning Autopilot off stops it. It writes its own
documents and approvals, passes your questions and instructions to
orchestrators, and asks orchestrators to `/wrap-up` finished work.

**It works your approvals, within limits (D-149 to D-152).** See
[What it does with approvals](#what-it-does-with-approvals-d-149-to-d-152).
Permission prompts stay yours, and everything else it does is recorded "by
Autopilot" with your Override or Reopen.

## Turning it on

Settings › Advanced › Experimental › **Autopilot**. It needs **Chat tabs** on,
because its agent is a chat tab on your own installed `claude` and its
sign-in: with Chat tabs off, the switch can't be turned on (it can still be
turned off). Turning it on adds an **Autopilot** row to the sidebar's top
list, below Loops and directly above Approvals, in the one-machine sidebar
and in All machines alike. Opening
Autopilot never starts an agent turn: it shows **Start**.

- **Pause** stops it from bringing new items. **Go on** resumes it.
- Turning it off stops the agent. Its run, stack and conversation are kept.
  Turning it on again picks up the same run.
- **New Autopilot Session** starts a fresh run, with a new folder and an
  empty stack. The old run's documents stay where they were.
- After Pane restarts, the current run shows Start again, with its stack and
  folder kept.

## Your instructions (D-196)

While Autopilot is on, Settings › **Autopilot** has a **Your instructions**
box: how you want it to work, for example "group things by repo", "always ask
before closing anything", "be brief" or "focus on Bloom first". They are kept
in a plain file on the machine Autopilot runs on,
`<PANE_DIR>/autopilot/instructions.md`, which you or a script can edit too.

- Autopilot reads them after Pane's own rules, labelled as yours: in its
  run's AGENTS.md (a section after Never) and in the Start line.
- Saved while it runs, they reach it at once as a `[Pane · Instructions]`
  line (shown in its chat as "Your instructions updated"), and the box says
  **Applied**. An edit to the file itself is picked up the same way within a
  couple of seconds. While it is stopped the box says **Applies on next
  Start**.
- They shape how it works but never override its hard limits: it never
  answers an approval or a permission prompt, and never merges, deletes,
  pushes or closes anything without your word.
- **View built-in instructions** shows what they add to (AGENTS.md, the Start
  line and the pane-autopilot skill), read-only. **Reset** clears yours.
- In Autopilot's chat you can say "from now on, group things by repo":
  Autopilot offers to add that line as its own approval, with the exact text,
  and adds it only when you approve.
- Longer than 20,000 characters is refused with
  `AUTOPILOT_INSTRUCTIONS_TOO_LONG`, and nothing is saved.

Autopilot is a paid feature (D-65). Every way it turns on or starts goes
through one entitlement check
(`main/src/services/autopilot/entitlement.ts`). For now it allows everyone,
with no account or network call. To check the refusal path, start a dev build
with `PANE_AUTOPILOT_ENTITLEMENT=denied`. Turning it on and Start then refuse
with `AUTOPILOT_NOT_ENTITLED`, and the switch can't be turned on.

## Where its data lives

Autopilot is not a Session. It has its own store, apart from Sessions, and
Session cleanup and `/wrap-up` never touch it:

```
<PANE_DIR>/autopilot/
  current              # the active run's id
  instructions.md      # your own instructions (Settings › Autopilot), for every run
  runs/<run-id>/
    AGENTS.md          # its instructions; points to the pane-autopilot skill
    CLAUDE.md          # @AGENTS.md
    docs/              # every document Autopilot writes
    stack.json         # the stack (references only: item ids, paths, URLs, Session ids)
    state.json         # last state and where the walk is
    run.json
    log                # one line per action, for people reading the folder
```

Its agent runs as a chat tab in a hidden, detached owner Pane
(`__autopilot_owner_<run-id>`) whose workspace is the run folder. That Pane has
no project, no Session record and no associations. Other machines' items show
on the stack, read live through the workspace. Nothing from them is copied
into the folder.

## What it does with approvals (D-149 to D-152)

There is no setting for this: it is how Autopilot works, in its skill, and it
takes its cues from you ("leave those to me", "handle the approvals"). By
default, Autopilot:

| It… | Recorded on the item, on every device |
| --- | --- |
| surfaces approvals from every machine, grouped so you can talk them through | |
| closes the ones that don't matter or that it judges stale; you can reopen them | "Closed by Autopilot: <reason>" |
| may close an unclear one and re-ask it rewritten; the answer goes to the original asker | "Closed by Autopilot: rewritten as …" on the old one, "Rewritten by Autopilot from Q-n" on the new one |
| answers only when the way forward is clear and the item relates to what it's working on with you, or when you tell it to handle approvals | "Answered by Autopilot · because <D-n, document or your words>", with **Override** |
| reads a typed reply its asker can't (D-258): takes it as an answer with `runpane notify --took`, or as a question, then finds out and sends a new version with `runpane notify --update` ([Replies](PANE_NOTIFY.md#replies-and-new-versions)) | "Autopilot is reading your reply…", then "Taken as your answer" or "Updated · ready again" |
| never answers a permission prompt, or types raw keys into another tab | refused in code ([The guard](#the-guard-d-149)) |

An answer is delivered at once, with no hold. Override sends your answer to the
asker as a correction, recorded on the item. Sentinel follows the same rules.

**Its queue (D-168).** Its watch tells it of approvals made outside its chat,
and `runpane autopilot waiting` is the queue: read from each machine's table,
with no copy. It tells you a count and brings in one group at a time, related
items together; when a group is finished it brings the next. An item answered
or closed elsewhere just leaves the queue.

**Across machines (D-165).** An approval lives on the machine where its creator
runs, and Autopilot's own on Autopilot's machine (from the phone, that's the
desktop the phone is talking to). Autopilot reads every connected machine, and
its answers and closes go to the owner, which records them "by Autopilot"; a
rewrite stays on the old item's machine. The owner takes the first answer or
close, so a later one, from another Autopilot or from you, is refused with
"already answered by …" and changes nothing. A saved machine it can't reach
shows as "<machine> offline", and an answer aimed at it is refused with nothing
queued. One of your Tailscale machines not saved here shows as "Can't see:
<machine>": a machine reads only the machines it has saved, so add it there. An
owner too old for these commands is reported as needing an update.

## In the chat and on the right (D-91)

- **The question lives in the chat.** Each item Autopilot brings is a
  decision card in its chat: what it is, its Q-n, Session and who asked; the
  question and its one-line why; and the options, the recommended one first
  and marked, each with its one-line detail. Choosing an option answers it.
  The same card shows on the phone. The card that is current shows in full;
  the others in a message are one line until you click them. If the current
  item isn't in any message in view, its card is docked above the composer.
- **The right side shows only the current item's context**, as tabs: its
  documents (HTML renders as a page, any other file as text), the app (a
  URL), a Session's overview. It never holds the question or answer buttons.
  A page follows Pane's theme, not the Mac's (D-163): whenever the page's
  `prefers-color-scheme` differs from Pane's light or dark, Pane swaps dark and
  light in the page's `prefers-color-scheme` rules (`guestColorScheme.ts`), so
  a document with dark styles shows dark whenever Pane does. Script in the page
  that asks `matchMedia` still gets the Mac's answer. Pane never attaches a DevTools
  debugger for this: one that stays attached crashes Electron 43 when the page
  closes (electron/electron#53376, D-216); any debugger goes through
  `attachDebugger` (`main/src/services/debuggerLifetime.ts`).
- **One at a time (D-71).** Items come in the order Autopilot puts them on
  its **stack**. New ones wait and never replace the current one. When you
  answer the current card, the next one becomes current and the right side
  follows it. **‹ ›**, **← →** (when you aren't typing) and the header chips
  step through everything on the stack.
- The right side's header (what it is, its Session, its title, its tabs)
  never moves. Long text and banners scroll below it (D-72).
- **What's waiting** lists every waiting item. Picking one makes it current.
- Answering shows "by you" on the card, with the Approvals Undo window.

Autopilot's own approvals are violet and marked "written by Autopilot". In
the Approvals screen they appear under an **Autopilot** group.

## On the phone (D-75 to D-77)

The phone shows the same Autopilot as the computer it is on, over the
host connection (`autopilot:*` channels, the `autopilot:changed` event). There
are no tabs on the phone.

- **Home** has an **Autopilot** row above Approvals ("Waiting on you") while
  Autopilot is on for that computer. Before Start it carries **Start**, which
  starts Autopilot and opens it; then it says Paused, or what it is walking,
  with how many items are open on the stack. A computer whose Pane predates
  Autopilot shows no row.
- **The Autopilot screen** is its chat tab, with the walk bar above it:
  Running or Paused, every Session with what waits in it (the current one
  violet), and **Pause** or **Go on**. Opening it never starts a turn: until
  Start it shows **Start**. Pane's `[Pane · Start]`-style lines show as short
  notices.
- **Decision cards.** Each item Autopilot names in an `autopilot-items` block
  is a card in the chat (the same `shared/autopilotDecision.ts` model as the
  desktop card). Tapping an option answers it at once, through Approvals'
  path (`notify:remote-command`), so the computer sees it as soon as it lands;
  the card then shows the answer and its Undo window, and later
  "by you · <Session> recorded it". **More context and related docs** opens
  the approval full screen.
- **The approval full screen**: "‹ Chat" and "n of N · Session" (n of N counts
  the items on the stack), the decision, then **More context** ("Why I'm
  asking", written by Autopilot, on its own items) and **Related docs**, which
  open and close. The answer buttons are fixed at the bottom: two options are
  buttons, more are picked above, an open question takes typed text.
  Answering goes back to the chat where you were.
- **A document** opens full screen with nothing to answer, and "‹ Back to Q-14
  to answer" returns to the approval. HTML files are read through the phone's
  connection (`autopilot:read-doc` with `{ inline: true }`); a page loads the
  way page tabs do. Only files on the stack, in the run's folder, or linked
  from a waiting item open.
- Phone builds without chat tabs (runtimes before 1.4) never show Autopilot:
  its owner Pane is hidden and they don't know its channels. Every 1.4 build
  gets this over the air. "Try a demo" has a sample Autopilot.

## Sentinel Mode (package 7, D-93)

A toggle in Autopilot's header (desktop and phone) for when you step away.
Turning it on also starts Autopilot; the sidebar row reads "Sentinel" while it
is on, and the walk bar says how many Sessions it keeps moving.

- Every 5 minutes, while Autopilot is idle and not paused, Pane wakes it with a
  `[Pane · Sentinel check]` line (hidden in the chat).
- It answers orchestrators' questions that a plan, a decision or a clear
  recommendation settles, citing the source; works approvals by the rules
  above; nudges a Session that has been quiet 10 minutes with open work (at
  most 2 per Session per hour, then it asks you); and sends everything else to
  you as its own approval, which pushes to your phone. It never answers
  permission prompts, merges, archives or creates Sessions.
- Each call shows in the chat as it happens (an `autopilot-log` block) and goes
  in `docs/away-log.html`. Turning Sentinel off posts a **While you were
  away** card (`autopilot-away`) with **Tell a Session otherwise** and the log.
  So does opening Autopilot (the desktop view, Pane coming to the front on it,
  or the phone screen) with Sentinel left on, whenever its away log has calls
  you haven't seen, however short the time away: Pane sends `[Pane · Back]`
  (`autopilot:opened`), and the card covers the calls since the last one. No
  new calls, or a stopped Autopilot, sends nothing.
- After a Pane restart Sentinel is off. Pane asks you, as a push, "Sentinel
  stopped: Pane restarted", with "Turn Sentinel back on".
- If Autopilot's agent exits on its own (it crashes, or the CLI quits),
  Autopilot stops too: Sentinel goes off, the checks end, and the view shows
  Start again. When Sentinel was on, Pane pushes "Autopilot stopped: its agent
  exited", with "Start again with Sentinel".
- The rules are instructions in the `pane-autopilot` skill; Pane runs only the
  toggle, the timer and the restart and exit questions. `autopilot:sentinel` (true or
  false) is the channel both screens use.

## From a brain-dump to Sessions (D-92)

Give Autopilot a pile of ideas and it sorts them into workstreams, writes
`docs/workstreams.html` (each proposed Session with its ideas and first
brief, new or existing), and asks "Start N workstreams?" as its own
approval. Only after you choose "Create them" does it create each Session
(`runpane sessions create`, an orchestrator only) and send its first brief,
marked `[From Autopilot]`. It keeps at most 2 Sessions it created working at
once, and waits while the machine is busy. These limits are instructions in
the skill; Pane does not enforce them yet.

## How the agent works

Autopilot follows the Pane-shipped `pane-autopilot` skill
(`main/src/services/paneChatBundle/skills/pane-autopilot/SKILL.md`). Its
controls reach it as `[Pane · Start]`, `[Pane · Pause]`, `[Pane · Go on]`,
`[Pane · Carry on]` and `[Pane · Instructions]` lines. It uses:

- `runpane autopilot waiting --json`, its queue: every waiting item on every
  machine it can reach, this machine's by Session in sidebar order, with
  `quiet`, `stale` and `connected` on each, and the `offline` and `cantSee`
  machines.
- `runpane autopilot answer <id> (--choice <label> | --approve | --deny |
  --text <text>) --because <why>`, `runpane autopilot close <id> --reason <why>`
  and `runpane autopilot rewrite <id> --ui ... --title ...`, on the machine that
  holds the item. Anyone but Autopilot is refused with `AUTOPILOT_ONLY`.
- `runpane autopilot stack push --item <id> [--next]` to put an item on the
  stack. It also takes `--file`, `--url` or `--session` instead of `--item`.
  `--next` puts a higher Session's new item right after the one on screen
  (D-59, "jumping back up"). While paused, a push from Autopilot is refused
  with `AUTOPILOT_PAUSED`.
- `runpane watch --as autopilot --kinds item.created,item.answered,session.created,session.archived,orchestrator.turn_ended --until-event --json`
  to wake on change, under its own cursor. See
  [SESSIONS.md](SESSIONS.md#autopilots-kinds).
- `runpane panels submit` / `panels wait --for idle` / `panels last-message`
  to ask an orchestrator, with the message marked `[From the person, via
  Autopilot]`. Every Session's fixed capability text accepts such a message
  as the person's own question or instruction, `/wrap-up` included. It never
  counts as an answer to an approval, and answering one goes through `runpane
  autopilot answer`. Autopilot's own messages are marked
  `[From Autopilot]`; an orchestrator replies to whoever asked and still
  sends anything the person must decide to them as an approval.

The seven `runpane autopilot` commands are also MCP tools in the `autopilot`
toolset ([PANE_MCP.md](PANE_MCP.md)). With Autopilot off, all but `status` fail
with `AUTOPILOT_OFF`, saying how to turn it on;
`status` reports `enabled: false` (its plain output also says how to turn it
on; `--json` gives only the state).

## The guard (D-149)

runpane sends the caller's Pane and tab (`PANE_SESSION_ID`, `PANE_PANEL_ID`)
on every daemon request (`caller` on the request frame; older builds leave it
out). Autopilot acts on approvals only through `runpane autopilot answer`,
`close` and `rewrite`, which record it, and `runpane notify --took` and
`--update` on a reply it reads; the machine that holds the item refuses
them for a permission prompt (`AUTOPILOT_CANNOT_ANSWER`), Claude tool permissions
and Bypass changes included. A guard on the command registry refuses every other
answer route when the caller is Autopilot's tab or owner Pane, since those
would read as the person's:

- `notify:remote-command` answer, undo, close, reopen and override, and dismiss,
  skip and remind (hiding or putting off a card is the person's call too)
- `permission:respond`
- `chat-tab:permission` and `chat-tab:answer` for any other tab
- every raw-input route: `runpane:panels:input`, `terminal:input`,
  `terminal:paste-file`, `terminal:paste-image`, `panels:send-input`,
  `panels:send-terminal-input`, `sessions:input`, `sessions:send-terminal-input`
- `runpane:panels:submit` and `submit-composer` to a tab with a waiting permission prompt

Sending a chat message to another chat tab (`chat-tab:send`) is allowed: it
queues a message and never answers that tab's pending prompt, whose own answer
routes are refused above.

The caller also travels with `runpane workspace <machine> ...` requests
(`caller` on the `/invoke` body), so another machine's guard refuses the same
routes.

Pane's own UI, phones and other screens send no caller, so you are never refused. The check relies on
the environment Pane gives its agents. It stops Autopilot on every normal
route. It is not a security boundary against an agent that deliberately
rewrites its own environment.

## Code map

| Part | Where |
| --- | --- |
| Manager, store, stack, entitlement, events | `main/src/services/autopilot/` |
| Channels (`autopilot:*`, `runpane:autopilot:*`) and the guard | `main/src/ipc/autopilot.ts` |
| Types | `shared/types/autopilot.ts` |
| Desktop view, stack, sidebar row | `frontend/src/components/autopilot/` |
| Settings › Autopilot (your instructions) | `frontend/src/components/settings/categories/AutopilotSettings.tsx` |
| Phone: home row, chat with cards, approval and document screens | `native/src/features/autopilot/`, routes in `native/src/app/autopilot/` |
| CLI | `packages/runpane/src/autopilot.ts`, `packages/runpane-py/src/runpane/autopilot.py` |
| Journeys (scripted agent) | `tests/autopilot.spec.ts` (`pnpm test:chat-tabs`) |
