---
name: pane-work
description: Answer questions about the user's own work in Pane, read-only. Recap what they worked on, finished, or shipped over a time window, or rank what to do next across panes, pull requests, issues, checks, and reviews. Use for "what have I been working on?", "what did I finish yesterday?", "what should I work on next?", "which PRs are closest to shipping?", or "what should I ignore for now?".
---

# Pane work questions

Two kinds of question, one set of evidence:

- **Recap** rebuilds memory: what happened, what shipped, what is still active,
  and what evidence exists.
- **Next** judges the queue: what to do first, what is blocked, what is close
  to shipping, and what to leave for now.

Answer in this conversation. This skill is read-only: repositories, panes,
branches, PRs, and deployments stay as they are unless the user explicitly asks
for a change.

## Scope

- **Time window.** An exact duration ("last 24 hours") is a rolling window from
  now. Calendar words ("yesterday", "this week") use the user's local calendar;
  otherwise state the timezone. An open-ended "recently" covers active panes
  plus panes archived or updated in the last 7 days. SQLite
  `CURRENT_TIMESTAMP` values are UTC; say whether times you report are local or
  UTC.
- **Next, with no window:** current state plus recent activity. By default,
  cover active panes, recently updated or archived panes, the 10 most recently
  active repositories, and GitHub queues the authenticated user can see.
  Respect any scope the user gives.

## Collect the evidence

Prefer RunPane JSON. Reading SQLite or logs directly is a fallback; say so and
note its caveats.

### 1. Pane state

```bash
runpane doctor --json
runpane panes list --json
runpane repos list --json
runpane agent-context --json
```

Find the Pane data directory from `runpane doctor --json`, `PANE_DIR`, or the
user. If a RunPane build offers a recap command, use it:

```bash
runpane panes recap --since <window> --include-active --include-archived --json
```

When archived history is missing, read `sessions.db` in the data directory if
the schema is there:

```bash
sqlite3 "$PANE_DIR/sessions.db" ".tables"
sqlite3 "$PANE_DIR/sessions.db" ".schema sessions"
```

Useful tables: `sessions` (name, status, archived flag, timestamps, worktree
path, project ID), `projects` (repository names and paths), `tool_panels`
(terminal and agent panels), and `session_outputs` (mostly archive logs). With
no `archived_at` column, use `archived = 1` plus `updated_at`, and say so.

### 2. Branches and PRs

For each pane or worktree, run git where the worktree still exists; otherwise
infer candidate branches from the saved repository path and the worktree slug.

```bash
git branch --all --format='%(refname:short)|%(committerdate:iso8601)|%(subject)'
gh pr list --repo <owner>/<repo> --head <branch> --state all \
  --json number,title,state,url,headRefName,baseRefName,createdAt,updatedAt,mergedAt,closedAt,author
```

For "next", also check the queues, review requests first:

```bash
gh search prs --review-requested=@me --state=open --archived=false \
  --json repository,number,title,url,author,updatedAt,isDraft --limit 100
gh search prs --author=@me --state=open --archived=false --sort updated --order desc \
  --json repository,number,title,url,author,updatedAt,isDraft --limit 100
gh search issues --assignee=@me --state=open --archived=false --sort updated --order desc \
  --json repository,number,title,url,updatedAt,labels,author --limit 100
gh pr view <number> --repo <owner>/<repo> \
  --json number,title,url,isDraft,author,updatedAt,reviewDecision,mergeStateStatus,statusCheckRollup,latestReviews,reviews,reviewRequests,comments,labels
```

- `statusCheckRollup` separates passing, failing, pending, and skipped checks.
- Search results omit `reviewDecision`; add it with `gh pr view` before ranking
  by review state.
- `comments` is top-level discussion only. Fetch inline review comments with
  `gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate` when the
  ranking depends on them.

### 3. Agent logs

Use transcript paths from RunPane when it gives them. Otherwise:

- Codex: `${CODEX_HOME:-$HOME/.codex}/sessions`, matched on
  `session_meta.payload.cwd`, the worktree path, branch slug, pane name, or PR
  URL.
- Claude: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`, matched on the
  worktree path slug, pane name, branch slug, or PR URL, including
  `subagents/*.meta.json`.

Search first with `rg -l`, then read only matching files. Pull out final
summaries, PR URLs, checks, deploy notes, and review findings; quote raw
transcripts only when asked.

## Judge

**Recap:** group into shipped or merged (merges, deploys, releases), finished
but not merged, still active or open, what agents did and what review caught,
and caveats. A pane can hold several workstreams; summarize the workstreams.
Local changes and open PRs are unshipped work.

**Next:** rank with this order as a starting point, then explain your judgment:

1. Review requests, incidents, security issues, billing or migration blockers,
   failed releases, broken deploys.
2. Open PRs close to shipping: passing checks, recent, a small follow-up left.
3. Draft PRs waiting on one human or product decision.
4. Active pane workstreams with recent activity and a clear next action.
5. Assigned high-priority issues (bug, security, reliability, data loss,
   billing, customer-facing).
6. Large backlog, stale PRs, old drafts, experiments.

Finish work near merge before starting new backlog, unless the new item is a
real incident or blocker. A pane name or an old branch alone doesn't make work
live; confirm with branches, PRs, logs, and recent updates.

Name the next skill for each item:

- Unknown failure or regression: `investigate`, or `bug-intake` to write it up.
- Fuzzy idea or open decision: `discussion`, then `options` or `brief`, then
  `create-ticket`.
- Clear implementation work: an implementation session with `tdd`,
  `quick-verify`, and `prepare-pr`.
- Finished branch that needs confidence: `review`, then `verify-app` or
  `pr-test-automation`.
- Open PR waiting on checks or bots: `babysit-pr`.
- Large finished diff: `refactor`.

## Answer

Lead with the answer:

```text
I would do <item> first, then <item>. The reason is <signal>.
```

or, for a recap:

```text
You shipped three things and had one open workstream in that window.
```

Then:

- **Next:** 3 to 7 ranked items, each with its link, why it ranks there, one
  concrete next action, the next skill, and any blocker. Add a short "probably
  not next" list when the queue is noisy.
- **Recap:** one entry per workstream (`pane` -> repo/branch -> PRs), with what
  changed, checks or deploys, and what is still open. Write it as a narrative;
  a table helps only for a dense PR list.

End with the evidence you used and its gaps (missing GitHub auth, removed
worktrees, unreadable logs). Call something shipped only with evidence: a
merge, release, deploy, passing checks, or a clear agent or PR record.
