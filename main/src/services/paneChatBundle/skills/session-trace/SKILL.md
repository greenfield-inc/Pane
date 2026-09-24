---
name: session-trace
description: Publish an agent session as a readable trace page in Grain, with the story, key moments, every request and step on a timeline, subagents, and the pull requests it opened. Use when asked for a trace or "how did this run go", or when a task already has a Grain page (for example from prepare-pr or handoff).
---

# Session trace

Turn a session into a page someone who wasn't there can read in five minutes: what was asked, what happened, where it went right or wrong, and what came out of it. A raw log is the evidence, not the page.

Read [references/page-guide.md](references/page-guide.md) first. It says what the page must answer, what to capture beyond the trace, and how to lay it out. [scripts/build-trace.mjs](scripts/build-trace.mjs) is a working starting point for Claude Code and Codex logs. Adapt it, or build the same page shape another way, when a harness or task needs something else.

## When to run

- When the user asks for a trace, a run review, or a page they can share about a session.
- Without being asked, only when the task already has a Grain page (a PR companion from `prepare-pr`, or a `handoff` page), or the session opened a pull request. Then attach the trace to that page. Don't run it after every session.

## Steps

1. **Find the session log.**
   - Claude Code: `~/.claude/projects/<project>/$CLAUDE_CODE_SESSION_ID.jsonl`, with subagents under `<session id>/subagents/`.
   - Codex: the newest `~/.codex/sessions/**/rollout-*.jsonl` whose first line (`session_meta`) has this working directory and no `parent_thread_id`. Its subagents are the rollouts whose `parent_thread_id` is its `id`.
   - The script finds both on its own; pass `--session FILE` to choose.
   - Other harnesses: see "Other harnesses" in the page guide.
2. **Read the session for the story.** Run `node scripts/build-trace.mjs --out <tmp> --outline` to list every request with its anchor (`t0`, `t1`, …). Use what you remember of the session plus that outline to write `story.json`: a plain summary and 4–8 key moments, as described in the guide.
3. **Build the page.** Run `node scripts/build-trace.mjs --out <dir> --story story.json --title "<task>: session trace" --back index.html`. This writes `trace.html` and `trace.otlp.json` (OpenTelemetry spans). Open the page and check the story, the moments, and that the PRs you know about are listed. Add missing PRs, releases, or artifacts by hand or by extending the script.
4. **Review before publishing.** The page shows every user message in full, including anything pasted (meeting notes, logs, customer text). Only emails and tokens are redacted automatically. Remove or trim anything the page's readers shouldn't see, and ask when unsure.
5. **Publish with Grain's installed skill when Grain is connected.** Otherwise save `trace.html` in the page bundle (see `page`) and report its path.
   - Add the page to the task's existing Grain workspace and link it from that workspace's main page, near the top.
   - With no existing page, create one in `Development Artifacts/<org>/<repo>`, named for the task.
   - Keep it private. Never create or widen a share. If the workspace already has a public share, tell the user the trace will be visible through it before you push.
6. **Report** the link, and anything you left out or couldn't capture.
