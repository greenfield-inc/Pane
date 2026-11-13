---
name: pane
description: Use whenever you work with Pane (the desktop app that runs coding agents in parallel git worktrees) through runpane or the pane MCP: in a Pane terminal (PANE_SESSION_ID is set), for Panes, panels, Sessions, agent tabs, asking the person (notify), showing a page, reading or sending to another panel, reaching another machine, or when runpane or the pane tools seem missing.
---

# Pane

Pane runs agents in terminal panels grouped into Panes, each Pane with its own
worktree. Sessions are orchestrator conversations that own Panes. You drive all
of it through the `runpane` CLI.

## Establish the control surface

1. Check for `runpane` on PATH. If it is absent, use Pane's bundled CLI in
   its place: `"$PANE_RUNPANE_BIN"`, else `~/.pane/bin/runpane` (or
   `$PANE_DIR/bin`; `runpane.cmd` on Windows). Only when neither exists, use
   `npx --yes runpane@latest` in place of `runpane` in every command below.
2. Run `runpane doctor --json`, then `runpane agent-context --json`. For a
   command's exact schema, run `runpane agent-context --command "<command>" --json`.
3. If runpane cannot be reached or doctor fails, stop and tell the user what
   failed. Do not substitute raw `git worktree` checkouts or built-in
   subagents for work that belongs in a Pane, and do not invent commands.
   From WSL when Pane runs on Windows, a Linux wrapper cannot reach the
   Windows named-pipe daemon. Use Pane's own shim, which runs the Windows CLI
   through WSL interop: `/mnt/c/Users/<you>/.pane/bin/runpane doctor --json`
   (Pane's WSL terminals already have it on PATH). With an older Pane, use
   `powershell.exe -NoProfile -Command 'Set-Location $env:TEMP; runpane doctor --json'`
   and that form for subsequent commands.

## Common commands

- Find a repository: `runpane repos list --json`
- 1 feature = 1 worktree = 1 branch = 1 Pane; reviews, audits, fixes and QA for it are tabs in that Pane.
- First check whether the work's branch already has a Pane: `runpane panes list --repo <repo> --json`, matching the PR's head branch against `git -C <worktreePath> branch --show-current`. If it does, use the tab command below.
- Start work whose branch has no Pane yet in a new Pane:
  `runpane panes create --repo <repo> --name <name> --agent <codex|claude|cursor> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json`
- For work that already has a Pane (review, audit, fixes, QA), open a new agent tab in that Pane, never a new Pane:
  `runpane panels create --pane <pane-id> --agent <codex|claude|cursor> --initial-input "<task>" --source agent --no-focus --wait-ready --yes --json`
- When `runpane agent-context --command "panels open" --json` lists the
  command, show the user a page or file with
  `runpane panels open --file <path> --source agent --yes --json` or
  `runpane panels open --url <url> --source agent --yes --json`.
- Inspect a Pane: `runpane panes list --json`, `runpane panels list --pane <pane-id> --json`
- Read or wait on a panel: `runpane panels screen --panel <panel-id> --limit 80 --json`,
  `runpane panels wait --panel <panel-id> --for idle --json`
- Send a message: `runpane panels submit --panel <panel-id> --text "<message>" --yes --json`
- Wait for workers with the one wait primitive, run as a background task that
  wakes you when it exits; act on its event, then run it again (the named
  cursor misses nothing in between). Use `--pane <pane-id>` instead of
  `--session` outside a Session:
  `runpane watch --session <session> --as <your-name> --until-event --json --kinds agent.report,agent.report.missing,agent.blocked,agent.ready,panel.exited,panel.stopped,panel.paused,pane.gone`
  Never pipe `runpane watch --follow` into `grep -m1` or `head` to wait:
  `--follow` never exits on news.
- Workers end with `runpane report --state <ready|blocked|failed|done> --summary-file <path>`
  (`--question` when blocked, `--pr` and `--head` when there is a PR).

## With the pane MCP tools

When the `pane` MCP tools are loaded, use them for the jobs above:
`agents_start` starts an agent on a task, `agents_status` checks on it, and
`agents_send` sends it a follow-up, each in one call. Answer a menu in an
agent's terminal with `panels_input` `keys`, then check `agents_status`.
Show the user a page or file with `panels_open` rather than the system
browser. Before guessing how Pane works, call `docs_search`, then
`docs_read`. When you need the person, use `notify` as the next section says
rather than asking in the terminal.

## Asking the person in Pane

### Which card

- **Claude's own card (AskUserQuestion)** only when all of these hold: you are answering the person's latest message in the chat they are typing in; the answer only steers this turn (nothing recorded as a decision, nothing for another agent, nothing irreversible or outward-facing); and the question stands on its own, without context, links or a Summary. Examples: "Update the snapshot too, or leave it?", "Which of these two files did you mean?"
- **An approval card** when any one of these holds: you are a worker in a Session; the person isn't in your chat right now; it blocks other work or waits; it needs context, references or a Summary; the answer is recorded as a decision (D-n); it approves an ask-first action. Examples: a plan approval, a sign-in the person must do, a migration.
- Unsure? Use an approval card. Codex and other agents without a built-in card always use an approval.
- How to post one: a worker runs `runpane report --state blocked --question "<title>" --summary-file <its status file>` (its `needs_you` gives the questions, options and files); a Session orchestrator runs `runpane notify` (or `--relays <item>` for a worker's question), never AskUserQuestion; any other agent calls the `notify` MCP tool or `runpane notify`.

### The card

- **Title**: what you need, about 80 to 100 characters on one line. Pane refuses a title over 160 characters or with a line break.
- **Subtitle** (`--context`, or `why` in `needs_you`): one or two sentences on why it matters, up to 240 characters. It shows under the title everywhere and opens the Summary.
- **Options**: 2 to 4, each with a consequence (`detail`), and exactly one recommended. Several questions go in `--questions` (in `needs_you`, one entry each); each gets its own buttons. Pane refuses two recommended options in one question.
- **References**: files, PRs, pages and other approvals (`{"label":"Q-12","approval":"<id|Q-n>"}`) in `--links` (`files` in `needs_you`), never bare paths in the text. When there is more to read, give the card a Summary page: an `.html` file passed as a worker's `--summary-file`, or a `summary` path in `needs_you`. It renders with scripts and network off, so it must read complete without JavaScript. Without one, Pane writes the Summary from the card.
- Pane prints a warning for each softer miss (a long title, no subtitle, no recommendation, more than 4 options, options without a consequence, unlinked paths). Fix them on the next card.

### Replies

- A typed reply may be an answer or a question. Whoever reads it runs `runpane notify --took <id|Q-n> answer` or `--took <id|Q-n> question`.
- For a question: find out, then `runpane notify --update <id|Q-n> --asked "<their question>" --what-changed "<one line per change>"` with any changed `--title`, `--context`, `--choices`, `--questions` or `--links`. The card shows "Updated · ready again" and waits for the answer. Don't post a second card.

### Posting an approval card

Post it with the `pane` MCP `notify` tool. If the `pane` MCP tools are not
loaded (some launchers start agents with a strict MCP config), run the same
call through the CLI:
`runpane notify --ui options --title "<question>" --context "<what it is for>" --choices '[{"label":"Ship it","detail":"<consequence>","recommended":true},{"label":"Wait"}]' --json`.
`--ui` is `options`, `approve` (`--detail`), `ask` (`--suggestions`) or
`info`. On `waiting`, run `runpane notify --resume <id> --json`; on
`unavailable`, ask in the terminal. Related questions go in one options card:
`--questions '[{"title":"<question>","choices":[...]},...]'` (2 to 4, one
pick each) instead of `--choices`.

### Reading a reply

Picks alone come back as before: `{answer}`, or
`answer: Q-n → <answer> (by you)` in your tab. Anything typed comes back as a
reply: the open call's result `{reply, picks?, id, replyId, next}` (pass its
`replyId` to `--took` and `--update`: only your call was given it, so it works
from outside a Pane tab too), or this line in your tab:
`reply: Q-n → "<their words>" (picked: <picks>) (by you)` (`(picked: …)`
only when they picked something; without a Q-n it names the title and ends
`[id <item id>]`). A reply is an answer or a question about the approval,
and you decide which:

- **An answer:** run `runpane notify --took <id|Q-n> answer --json`, then act
  on it.
- **A question:** run `runpane notify --took <id|Q-n> question --json` at
  once (the approval reads "Getting more context…"; `--status "<text>"` says
  what you're doing instead). Find out, then run
  `runpane notify --update <id|Q-n> --asked "<their question>" --what-changed "<one line per change>" --json`
  with any changed `--title`, `--context`, `--choices`, `--questions` or
  `--links`. A reworded choice carries `"was":"<old label>"`. That saves a
  new version of the same approval, shown as "Updated · ready again"; never
  post a second approval for it. `--update` waits for the answer like a
  notify call.
- **The person can fix how you took it.**
  `correction: Q-n → that was a question: "…" (by you)` means treat it as a
  question: update the approval.
  `correction: Q-n → that was your answer: "…" (by you)` means it is recorded
  as the answer: act on it.

Only the reply's reader may run `--took` and `--update`: the asker, else the
orchestrator that relayed a worker's question, else Autopilot.

### Who asks, by role

- **A worker in a Session** (`PANE_SESSION_DIR` is set and
  `PANE_ORCHESTRATION_SESSION_ID` isn't, or your brief names an orchestrator
  or a parent status file) doesn't call `notify`. Run
  `runpane report --state blocked --question "<question>"` (with
  `--summary-file <status file>` when you keep one, after writing the
  question there). It shows at once in Approvals with an answer box, and it rings when
  your orchestrator relays it or after 10 minutes. The answer reaches this tab as
  `answer: Q-n → <answer> (by you)`; `closed: Q-n (by you)` and
  `correction: Q-n → <answer> (by you)` are the person's word too. A typed
  reply reaches this tab as a `reply:` line: read it as above (`--took` and
  `--update` aren't new asks, so a worker runs them).
- **A Session orchestrator** (`PANE_ORCHESTRATION_SESSION_ID` is set) keeps
  each item that waits on the person posted once, as a background
  `runpane notify ... --links '<files>' --json` titled with its Q-n, and
  stays free to talk: follow "What waits on the person" in
  `runpane docs read --doc skills/pane-orchestration/SKILL.md`. A reply to a
  worker's question it relayed comes to it when the worker can't read it.
- **Any other agent** calls `notify` as above.

### Secrets

For an API key, token or password, call the `secrets_request` tool (or
`runpane secrets request --project <project> --name <NAME> --title "<text>" --reason "<what it is for>"`),
never `ask`. Pane saves the value as a Pane secret and returns only saved or
declined; run commands with it through `runpane secrets exec`. If it returns
`unavailable`, ask the person to save it in Pane under Settings > Secrets.

## When something looks missing

- Pane keeps its data in `~/.pane` (or `$PANE_DIR`): `bin/` the CLI shims,
  `logs/` app logs, `sessions/<id>/` each Session's folder (plans, prompts,
  `status/` worker status files), `skills/` Pane's bundled skills, `updates/`.
- Which Pane and Session you are in: `PANE_SESSION_ID` (your Pane),
  `PANE_PANEL_ID`, `PANE_ORCHESTRATION_SESSION_ID`; then `runpane panes list --json`
  or `runpane sessions overview --session <id> --json` shows who owns what.
- Health and setup: `runpane doctor --json` names what is wrong and the fix.
- How something in Pane works: `runpane docs search --query "<words>"`, then
  `runpane docs read --doc <path>`.
- Another machine in the person's workspace: `runpane workspace list`, then
  `runpane workspace <machine> exec -- <command>`.

## Orchestrating workers

To launch, wait on, answer or resume workers (including wrappers launched with
`--tool-command`, such as `agent-farm run`), read and follow Pane's
orchestrator guide: `runpane docs read --doc skills/pane-orchestration/SKILL.md`.
It covers delivery checks, what each wake means, worker reports and status
files, resume after a restart, showing pages, and shared-checkout etiquette.

## Sessions

When `PANE_ORCHESTRATION_SESSION_ID` is set you are a Session orchestrator.
When `panes create` or `panes adopt` returns an `association` result,
check `association.ok`. Confirm with
`runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json`.
If the Pane is absent, including when an older CLI returns no association
result, run `runpane sessions associate --session "$PANE_ORCHESTRATION_SESSION_ID" --pane <pane-id> --json`
and confirm again before sending work.
Never take over a Pane that belongs to another Session.

Opening a terminal or Session is not a request to start work. Act on the
user's request, and do not focus Pane windows unless the user asks.
