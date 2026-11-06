---
name: wrap-up
description: Wrap up a Pane Session in one step - take stock of its Panes, tell the person first about anything that needs their attention, archive every Pane that is safe to archive, close the tabs you opened, and report what was kept and why. The Session itself stays open; archiving it is the person's call. Use only as a Pane Session orchestrator, when the person types /wrap-up or asks to wrap up the Session.
---

# Wrap up this Session

This is for the orchestrator of a Pane Session, the conversation whose
`PANE_ORCHESTRATION_SESSION_ID` is set. If it isn't set, you are not a Session
orchestrator: say that /wrap-up only wraps up a Session, and stop. Everything
below acts on this Session only.

/wrap-up archives the Session's Panes (their worktrees), not the Session. The
Session stays open with your report in it; the person archives it themselves
when they are done with it.

## 1. Take stock

Read your work list where you keep one, and
`runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json`.
Sort each of the Session's Panes:

- **finished**: its PR merged or closed;
- **parked**: its PR is open, all its work is pushed, and no agent in it is
  working;
- **busy**: an agent in it is mid-turn or waiting for an answer;
- **unsafe**: it holds uncommitted or unpushed work.

Take each PR's state from
`runpane panes archive --session "$PANE_ORCHESTRATION_SESSION_ID" --merged --closed --dry-run --json`,
which asks GitHub now (`items[].pr`), not from `sessions overview`, whose PR
state can lag a merge by minutes. `runpane panes archive --pane <id> --dry-run --json`
tells you whether a Pane is clean and whether an agent in it is busy.

## 2. Tell the person first, if anything needs attention

Before archiving anything, if any of these exist, tell the person in one
message, one line each:

- uncommitted or unpushed work (those Panes will be kept);
- open PRs (their Panes are archived; the PRs stay open on GitHub);
- commits no review has covered, as your work list records them;
- agents still working or waiting for an answer (their Panes will be kept);
- items on your work list that are still open (they will be marked dropped).

Post it once with
`runpane notify --ui info --title "Wrapping up: N things need attention" --context "<the list>" --json`
(it returns at once), and write the same items here, in this conversation:
every item on the card, worded the same. This is a notice, not a
question: /wrap-up asks nothing and doesn't wait for an answer. If nothing
needs attention, skip straight to step 3.

## 3. Archive what is safe

- Stop the background notify calls you hold. Keep one watcher only if a
  worker is still working (see below).
- Close every tab you opened, the status document included, with
  `runpane panels close --panel <id> --yes --json`. It refuses a tab the
  person opened, an agent mid-turn and unsent text; leave those open.
- Archive every Pane whose dry run is clean, parked ones too: run
  `runpane panes archive --pane <id> --dry-run --json`, then the same with
  `--yes` instead of `--dry-run` when it is clean. For many Panes at once,
  `runpane panes archive --session "$PANE_ORCHESTRATION_SESSION_ID" --merged --closed --dry-run --json`
  covers the finished ones. An open PR stays open on GitHub, and
  `runpane panes restore` brings the worktree back.
- Keep every unsafe Pane, and any Pane whose dry run or archive is refused.
  Never pass `--force`; list the Pane in the report with its next step.
- A worker still working (`agent-busy`) is left to finish: keep its Pane and
  its work-list item. Watch it until it reports or goes idle
  (`runpane panels wait --panel <id> --for idle --json`; `--for ready` only
  means its input box is showing), then archive its Pane if the dry run is
  clean (keep it and say why if not) and report again (step 4).
- Mark every other open item on your work list dropped.

Never archive the Session itself, and never run `runpane sessions update`
with `archived`: that is the person's action.

## 4. Report: always, as your last message

Never skip this, even when everything was archived and nothing was kept. Your
final message lists:

- what was archived;
- what was kept and why, with the next step for each;
- the PRs still open, as the live lookup in step 1 (or `gh pr view`) reports them;
- how to restore a Pane (`runpane panes restore`, or the Archived section in
  the sidebar);
- that the Session stays open, and the person can archive it from the
  sidebar (right-click it, or its ⋯ button) when they are done with it.

While a worker is still working, name it and end with "I'll archive
<worker>'s Pane when it finishes." Otherwise end the final report with
"Nothing left to do in this Session."

## Never

/wrap-up never merges a PR, commits or pushes for a worker, passes `--force`,
deletes a branch, closes a tab the person opened, archives the Session, or
touches a Pane or tab outside this Session (including standalone Panes).
