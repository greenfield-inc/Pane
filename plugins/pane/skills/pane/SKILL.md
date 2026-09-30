---
name: pane
description: Start, check on, and message coding agents (Codex, Claude Code, Cursor) that Pane runs on the user's Mac, each in its own git worktree. Use when the user wants an agent to work on a task in one of their repos, asks how an agent is doing, wants to send an agent a follow-up, or wants to see the agents this chat started.
---

# Pane

Pane is a desktop app that runs coding agents side by side, each in its own git worktree called a Pane. These tools drive the Pane app running on this Mac.

## Start an agent
1. Call `repos_list` to find the repo. Use its name or id as `repo`.
2. Call `agents_start` with `repo`, a short kebab-case `name`, `agent` (`codex`, `claude`, or `cursor`), the task as `prompt`, and `yes: true`. Pass `yes: true` only when the user asked for the agent.
3. Tell the user the Pane's name and its `pane://` link. Offer the Chat agents panel (`agents_panel`), which shows every agent this chat started.

## Check on agents
- `agents_status` with `pane` returns `working`, `ready`, `blocked`, `idle`, or `exited`, plus the agent's screen. Report what the screen shows; don't guess progress.
- `blocked` means the agent waits on a prompt. Show the user the question and ask how to answer before sending anything. The same goes for setup, trust, and permission screens, whatever the status says.
- `workspace_state` returns every Pane and agent at once.

## Message an agent
- `agents_send` with `pane`, `text`, and `yes: true` types the message and submits it. Confirm it reports `delivered: true`.
- To answer a menu (arrow keys, Enter, Escape) once the user has chosen, use `panels_input` with named keys, then check with `agents_status`.

## Show the panel
`agents_panel` opens the Chat agents panel beside the chat. It lists the agents this chat started with live status. The user can message an agent or open it in Pane from there.

## Other tools
- `panes_list` and `panes_git_status` show open Panes and their git state.
- `links_create` returns a `pane://` link to a Pane, panel, or repo.
- `panes_archive` removes a Pane's worktree; `panes_restore` brings it back. Archive only when the user asks.
- `docs_search`, then `docs_read`, answer questions about how Pane works.
- `doctor` diagnoses a missing or unreachable Pane app. If tools fail to reach Pane, ask the user to open the Pane desktop app.
