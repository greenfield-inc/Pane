# Tool Panel System Implementation Guidelines

⚠️ **IMPORTANT**: The tool panel system implements a flexible, extensible architecture for managing multiple tool instances per session.

## Architecture Overview

The tool panel system consists of several key components:

1. **Panel Manager** (`main/src/services/panelManager.ts`): Central coordinator for panel lifecycle management
2. **Terminal Panel Manager** (`main/src/services/terminalPanelManager.ts`): Specialized handler for terminal panel processes
3. **Panel Event Bus** (`main/src/services/panelEventBus.ts`): Event communication system between panels
4. **Panel Store** (`frontend/src/stores/panelStore.ts`): Frontend state management with Zustand
5. **Panel Components**: React components for rendering different panel types

## Key Implementation Principles

1. **Lazy Initialization**: Panels are created in the database immediately but background processes (like terminal PTY) only start when the panel is first viewed
2. **State Persistence**: All panel state including terminal scrollback, working directories, and configurations persist across application restarts
3. **Memory Efficiency**: Inactive panels suspend rendering but maintain background processes
4. **Event-Driven Updates**: Uses IPC events to synchronize state between main and renderer processes
5. **Extensible Design**: Architecture supports future panel types beyond terminals

## Panel Lifecycle

1. **Creation**: User clicks "Add Tool" → Panel entry created in database → Added to UI
2. **First View**: User clicks panel tab → Background process initializes → XTerm.js mounts
3. **Switching**: User switches panels → Previous panel unmounts XTerm → New panel mounts
4. **Background Operation**: Processes continue running even when panel is not visible
5. **Deletion**: Panel closed → Process terminated → Database entry removed → UI updated

## Terminal Panel Specifics

- Each terminal panel spawns an independent PTY process using node-pty
- Terminal metadata (cwd, dimensions, agent session) persists in `tool_panels.state` as JSON, ceilinged at 256 KB per panel and merged key by key inside SQLite
- Terminal bytes (scrollback, serialized snapshot, alternate-screen frame) persist in `panel_buffers`, capped at 4 MB per panel with the oldest scrollback trimmed first
- XTerm.js instances mount/unmount based on panel visibility to save memory
- Working directories are maintained independently per panel
- Command history and environment variables can be preserved across restarts
- Cmd-click on macOS or Ctrl-click on Windows/Linux opens `pane://open?pane=<pane-id>&panel=<panel-id>` links in terminal output inside Pane. The panel parameter is optional.

## Database Schema

- `tool_panels` table stores panel configuration and state
- `sessions.active_panel_id` is the last-used tab per session: the one any client picked most recently. A client with no memory of a Pane opens it there, and `runpane panels list` reports it as active
- Foreign key constraints ensure panels are cleaned up when sessions are deleted

## Event System

- A client's tab click (`panels:set-active`), `runpane panes focus` and opening a Session view update `active_panel_id` and move no other client. A host- or agent-initiated activation (`runpane panels open`, `panels create`/`panes create` with focus, Pane Chat, new-Pane setup, run scripts) sends `panel:activeChanged` (`PanelActivationRequest`), which only clients already showing that Pane follow
- The remote web and mobile app remembers its own Pane, Session and tab per host in browser storage. The desktop still opens a Pane on `active_panel_id` and the stored `panel_layout`
- Terminal panels emit `terminal:command_executed`, `terminal:exit`, and `files:changed` events
- Event bus routes events to subscribed panels (planned for future panel types)
- Events support future inter-panel communication (e.g., diff panels reacting to file changes)

## Implemented Panel Types

The tool panel system supports 8 panel types (`ToolPanelType` in `shared/types/panels.ts`):

1. **Terminal** (`terminal`): PTY shells, several per pane. Agent CLIs such as
   Claude Code, Codex and Cursor Agent run in terminal panels
   (`TerminalPanelState.agentType` records which one).
2. **Diff** (`diff`): git diff viewer. Singleton, permanent, worktrees only.
3. **Explorer** (`explorer`): file tree.
4. **Editor** (`editor`): Monaco editor, one tab per open file.
5. **Logs** (`logs`): script execution output. Singleton.
6. **Dashboard** (`dashboard`): project overview. Singleton, permanent,
   projects only.
7. **Setup Tasks** (`setup-tasks`): project setup checklist. Singleton,
   permanent, projects only.
8. **Browser** (`browser`): embedded browser. Worktrees only.

## Panel Capabilities

Each panel type has specific capabilities defined in `PANEL_CAPABILITIES`:

- **requiresProcess**: Whether panel needs background process (terminal, logs)
- **singleton**: Only one instance per session (diff, logs, dashboard, setup-tasks)
- **permanent**: Cannot be closed by user (diff, dashboard, setup-tasks)
- **canAppearInProjects**: Available in project view (all except diff and browser)
- **canAppearInWorktrees**: Available in worktree sessions (all except dashboard, setup-tasks)
- **canEmit**: Events this panel can produce
- **canConsume**: Events this panel listens to

Example: Diff panels are singleton + permanent + worktree-only, consuming `files:changed` and `terminal:command_executed` events to auto-refresh.

### Named custom launch profiles

In a worktree's **Add Tool (+)** menu, choose **Add custom command…** and enter
an optional **Name** alongside the command. **Save & launch** saves the profile
and opens a terminal tab with that name. Leaving the name blank uses the first
three words of the command. Saved profiles are shared through app configuration.
Use the pencil beside a saved profile to rename it; the menu and future tabs use
the new name. Existing tabs keep their titles. Hover a profile to see its full
name and command.

Resume commands retain the original shell quoting and environment assignments when removing a launch prompt. Custom Claude launchers may choose a separate configuration directory; Pane trusts their recorded conversation IDs instead of checking the app configuration for their transcripts.
