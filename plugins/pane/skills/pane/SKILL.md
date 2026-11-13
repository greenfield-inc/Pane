---
name: pane
description: Start, check on, and message coding agents (Codex, Claude Code, Cursor) that Pane runs on the user's Mac, each in its own git worktree, and read what waits on the user in Pane (approvals, Session inboxes, Autopilot). Use when the user wants an agent to work on a task in one of their repos, asks how an agent is doing, wants to send an agent a follow-up, wants to see the agents this chat started, or asks what Pane needs from them.
---

# Pane

Pane is a desktop app that runs coding agents side by side, each in its own git worktree called a Pane. These tools drive the Pane app running on this Mac.

## Start an agent
1. Call `repos_list` to find the repo. Use its name or id as `repo`.
2. Call `agents_start` with `repo`, a short kebab-case `name`, `agent` (`codex`, `claude`, or `cursor`), the task as `prompt`, and `yes: true`. Pass `yes: true` only when the user asked for the agent.
3. Tell the user the Pane's name and its `pane://` link. Offer the Chat agents panel (`agents_panel`), which shows every agent this chat started.
4. For more work on an agent's branch (a review, a fix, a test pass), call `agents_start` with `pane` set to that agent's Pane id instead of `repo` and `name`. The new agent opens as a tab in the same Pane and worktree.
5. When the user wants Claude or Codex as a chat tab instead of a terminal, call `panels_create` with `pane`, `agent` (`claude` or `codex`), `chat: true`, the task as `initialInput`, and `yes: true`. It joins this chat's agents like any other.

## Check on agents
- `agents_status` with `panel` (the panel id from `agents_start` or `agents_panel`) or `pane` returns `working`, `ready`, `blocked`, `idle`, or `exited`, plus the agent's screen and its latest `report` when it filed one. Report what the screen and report show; don't guess progress.
- `blocked` means the agent shows a prompt in its terminal: a permission, trust or question menu. Tell the user what it asks and that they answer it in Pane (`links_create` gives a link). `agents_send` refuses while an agent is blocked. Never try to answer a prompt with a message.
- A report with `state: blocked` and a `question` is different: the agent is at its message box, so pass the user's answer with `agents_send`.
- `workspace_state` returns every Pane and agent at once.

## Message an agent
- `agents_send` with `panel` (or `pane`), `text`, and `yes: true` types the message and submits it. Confirm it reports `delivered: true`.

## What waits on the user
These are read-only here. The user answers approvals in Pane or on their phone.
- `autopilot_status` says whether Autopilot is on. With it on, `autopilot_waiting` lists every approval and question waiting on the user, on every machine, grouped by Session, and `autopilot_stack` lists what Autopilot has put in front of them. With it off, those two fail with `AUTOPILOT_OFF`; say so and use the Session inboxes.
- `sessions_list` lists Sessions. `inbox` with `session` lists a Session's worker reports and blocked agents, and `sessions_overview` shows its Panes, agents and PRs.
- Summarize what waits, oldest and blocking first, with a `pane://` link for each.

## Show agents
- `agents_start`, `agents_status` and `agents_send` results show as a Pane card in the chat, so keep your reply short and don't repeat what the card shows.
- `agents_panel` opens the Chat agents panel beside the chat: every agent this chat started, with live status, terminal and pull request. The user can message an agent or open it in Pane from there.
- When the user asks about one agent, call `agents_panel_focus` with its name. It shows that agent's card and selects it in the panel.

## Other tools
- `panes_list` and `panes_git_status` show open Panes and their git state.
- `links_create` returns a `pane://` link to a Pane, panel, or repo.
- `panes_archive` removes a Pane's worktree; `panes_restore` brings it back. Archive only when the user asks. When it refuses because work would be lost, tell the user what it flagged and pass `force: true` only if they agree.
- `docs_search`, then `docs_read`, answer questions about how Pane works.
- `doctor` diagnoses a missing or unreachable Pane app. If tools fail to reach Pane, ask the user to open the Pane desktop app.
