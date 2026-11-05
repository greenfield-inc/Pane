---
name: session-trace
description: Publish agent sessions as readable trace pages in the workspace's document destination, with the story, key moments, every request and step on a timeline, subagents, and the pull requests it opened. Use when asked for a trace or "how did this run go", when a task already has a published page (for example from prepare-pr or handoff), or when an orchestrator collects the traces of a Session.
---

# Session trace

Turn a session into a page someone who wasn't there can read in five minutes: what was asked, what happened, where it went right or wrong, and what came out of it. A raw log is the evidence, not the page.

Read [references/page-guide.md](references/page-guide.md) first. It says what the page must answer, what to capture beyond the trace, and how to lay it out. [scripts/build-trace.mjs](scripts/build-trace.mjs) is a working starting point for Claude Code and Codex logs. Adapt it, or build the same page shape another way, when a harness or task needs something else.

## When to run

- When the user asks for a trace, a run review, or a page they can share about a session.
- When a page bundle asks for `trace.html`, build it and refresh it at meaningful handoffs and after implementation finishes, when conversation capture is explicitly authorized. If capture is unavailable or unauthorized, put a clearly labeled status page in its place.
- An orchestrator collects one trace for every session in its ledger whose capture is granted: its own, and each worker it launched. A grant comes only from the user or from the workspace instructions of the repository the session worked in, when they explicitly allow conversation capture or full traces. Naming a document destination is not a grant, and neither is a personal fallback workspace. Without a grant, publish the labeled status page in the trace's place and list the session as "trace not authorized".
- Otherwise run it without being asked only when the task already has a published page (a PR companion from `prepare-pr`, or a `handoff` page), or the session opened a pull request. Then attach the trace to that page. Don't run it after every session.

## Steps

1. **Identify the authorized task sessions.** Pass `--session FILE` with the current task's own session file; the newest log may belong to another task. Include only this task and its known descendants. Record missing sessions and running snapshots. An orchestrator takes the list of sessions from its ledger and builds one page per session.
   - Claude Code: `~/.claude/projects/<project>/$CLAUDE_CODE_SESSION_ID.jsonl`, with subagents under `<session id>/subagents/`.
   - Codex: the newest `<codex home>/sessions/**/rollout-*.jsonl` whose first line (`session_meta`) has this working directory and no `parent_thread_id`. Its subagents are the rollouts in the same Codex home whose `parent_thread_id` is its `id`. A launcher may give each Codex launch its own home and set `CODEX_HOME`; otherwise the home is `~/.codex`.
   - The script finds the current session on its own, searching `$CODEX_HOME` before `~/.codex`, and finds subagents beside the selected session. Pass `--session FILE` to choose a log, or `--codex-home DIR` to search another home.
   - For another worker, pass `--session` with the log file it reported. A Claude worker's log is under the `~/.claude/projects/` folder named for its worktree path.
   - Other harnesses: see "Other harnesses" in the page guide.
2. **Read the session for the story.** Run `node scripts/build-trace.mjs --session <task-session.jsonl> --out <tmp> --outline` to list every request with its anchor (`t0`, `t1`, …). Use what you remember of the session plus that outline to write `story.json`: a plain summary and 4–8 key moments, as described in the guide.
3. **Build the page.** Run `node scripts/build-trace.mjs --session <task-session.jsonl> --out <dir> --story story.json --title "<task>: session trace" --back index.html`. This writes `trace.html` and `trace.otlp.json` (OpenTelemetry spans). Open the page and check the story, the moments, and that the PRs you know about are listed. Add missing PRs, releases, or artifacts by hand or by extending the script.
4. **Review before publishing.** The page shows every user message in full, including anything pasted (meeting notes, logs, customer text). Only emails and tokens are redacted automatically. Remove or trim anything the page's readers shouldn't see, and ask when unsure.
5. **Publish to the document destination your workspace instructions name.** Otherwise save `trace.html` in the work's page bundle (see [`page`](../page/SKILL.md)) and report its path.
   - Add the page to the task's existing page or bundle and link it from its main page, near the top.
   - In an orchestrated Session, put each trace in its item's bundle, link it from the item's front page, and list it in the Session status page's sources. The orchestrator's own trace goes in the Session folder beside the status page.
   - With no existing page, create one in the folder the workspace instructions name, titled for the task.
   - Keep it private. Never create or widen a share. If the destination already shares the page publicly, tell the user the trace will be visible through it before you publish.
6. **Report** the link, and anything you left out or couldn't capture.
