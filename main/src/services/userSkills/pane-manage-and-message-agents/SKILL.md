---
name: pane-manage-and-message-agents
description: Use when the user asks to start, kick off, spawn, check on, nudge, follow up with, or babysit another coding agent (Claude, Codex, or Cursor) in Pane, or to create a Pane for that work.
---

# Manage and message Pane agents

You coordinate. Another agent in a Pane does the work.

If you are already Pane Chat / a Session orchestrator, follow `pane-orchestrator` and `runpane`.

## Trivial work stays here

Lookups, one-line nudges, and status checks belong in this turn: list panes, read doctor, send "CI failed on X".

When they asked for an agent, that agent owns implementation, debugging, commits, and the PR. "It's not done until a PR exists" stays with that agent until they take the task back.

## Use Pane

Prefer Pane MCP (`agents_start`, `agents_status`, `agents_send`, `repos_list`, `panes_list`, `docs_search`). If those tools aren't in this session, use `runpane` the same way (`runpane agent-context --json` first).

`yes: true` / `--yes` only when they asked for the change (start a pane, send a message, archive). Discover ids from `repos_list` / `panes_list` before guessing.

## Start, check, follow up

- **Start:** `agents_start` with repo, a short pane name, the agent they named (`codex` / `claude` / `cursor`), and the full task. The worker has none of this chat: put goal, constraints, paths, and "done means" in the prompt. Create in the background.
- **Check:** `agents_status`. Report what the screen shows. Check once per ask; babysit when they asked you to keep watching.
- **Follow up:** `agents_send` for a message. Menus and trust prompts: `panels_input` for keys, and ask the user before accepting a permission prompt.

If start fails, say so and wait.

## Hand them the link as text

Print the `pane://open?...` URL on its own line, exactly as returned.

## When they say keep going

Nudge the same pane with `agents_send`.
