# Export and import your Pane setup

**Settings › Import & Export**, after Privacy in the Settings sidebar, saves
your Pane setup to a file and loads it on another computer.

## Export

The page lists eight sections, each with what it would save. Click a row to
leave that section out, then click **Export…** and pick where to save
`pane-setup-YYYY-MM-DD.json`. When it is saved, **Show in Finder** (**Show in
folder** on Windows and Linux) opens its folder.

| Section | What it saves |
| --- | --- |
| Agent presets | Pane Chat agent, agent interface, the default Session command, resume, profile and pin, permission mode and model |
| Custom commands | Every custom command: name, command and resume templates |
| Run scripts | Each saved repository's Build Script, Run Commands and Archive Script, keyed by its `origin` remote |
| Skills & MCP | Whether Pane's skill is installed and its MCP server registered, and the MCP toolsets |
| Terminal shortcuts | Every terminal shortcut |
| Worktree file sync | Every file sync entry with a relative path |
| Appearance | Appearance mode, themes, high contrast, UI scale, terminal font and size |
| Preferences | The current value of each behavior toggle from General, Notifications, Shortcuts, Worktrees & Git and Advanced, new-Pane defaults (without the base branch), and the sidebar and `@terminal` choices |

### What is never in the file

The file is built from a list of named settings, so anything not listed above
is never written. That includes every API key and token Pane stores (Anthropic,
OpenAI, fal, OpenRouter, Deepgram, APNs), shared credentials, Remote Pane and
Workspaces settings, analytics settings and identity, leaderboard, the Claude
executable path, extra PATH entries, the preferred shell, start on login,
Publish Pane instructions to AGENTS.md, developer and verbose modes, and each
repository's path, worktree folder, Open IDE Command and Project System
Prompt. Notes, Loops and Sessions are not part of the setup.

Free text can still hold a secret someone typed into it. As a second check,
Pane leaves out any command, resume template, script, Session profile or
shortcut text that looks like it holds one:

- a key assignment such as `API_TOKEN=abc` or `password: x` (a variable
  reference such as `API_TOKEN=$API_TOKEN` is kept);
- a flag with a value such as `--password x` or `--token=x` (`--token-file ./x`
  is kept);
- an `Authorization` or `Cookie` header;
- credentials in a URL (`postgres://user:pass@host`) or a secret in its query;
- a well-known key prefix (`sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`).

The smallest unit is left out: one command, one shortcut, one script of one
repository, or one setting. The card names each one and counts it on its row.
This check is best effort, so read the file before you share it.

Your home folder is written as `~` in commands and scripts, so
`/Users/ana/bin/serve` is saved as `~/bin/serve`.

## Import

Click **Import…** and choose a setup file. Nothing changes yet: the card shows
what importing would change on this computer, section by section. Expand a row
to see each item it adds or replaces, with the exact text of every command and
script and, for a replacement, what it was. A section with no changes is dimmed
and can't be selected. Uncheck any section you don't want, then click
**Import N sections**.

Import adds and replaces. It never deletes:

| Kind | Rule |
| --- | --- |
| Single settings | The file's value replaces this computer's when they differ |
| Custom commands | Matched by name. A new name is added; the same name with a different command replaces it; commands only on this computer stay |
| Terminal shortcuts | Matched by id, same rules. A shortcut whose key another shortcut here already uses comes in turned off, marked "key in use" |
| Worktree file sync | Matched by path, same rules |
| Run scripts | See below |

Because nothing is deleted, a default shortcut or file sync entry you removed
on the first computer stays on the second one. Remove it there by hand.

A leading `~/` or `~\` in a command or script becomes this computer's home
folder, and the preview shows the result. Scripts are not translated between
operating systems: when the file was written on another OS, the Run scripts row
says so ("written on macOS").

Importing Skills & MCP does what the toggles in **AI & Agents** do: turning MCP
on registers Pane's server in your Claude Code, Codex and Cursor configs, and
turning the skill on installs it in your home skill folders.

### Run scripts

Each repository in the file applies to every saved repository here whose
`origin` remote is the same host, owner and repository, whether it is cloned
over SSH or HTTPS. `github.com/acme/web` does not match `gitlab.com/acme/web`.
A repository exported without a remote matches by name, and only when exactly
one repository here has that name.

- Only scripts in the file are written; an empty script never clears yours.
- A script the repository's own `pane.json` (or another
  [config file](CONFIG_FILES.md)) provides is skipped, so the team's file keeps
  working.
- A repository that isn't saved in Pane on this computer is skipped and named.
  Import never creates repositories or clones them.

Build and archive scripts run on their own when a worktree is created or
archived, which is why the preview shows their full text.

### When a file is refused

Pane refuses a file that isn't JSON, isn't a Pane setup file, was written by a
newer Pane, is larger than 1 MB, or has a section in the wrong shape. The card
says why, that nothing changed, and what to do next. Sections and settings Pane
doesn't know are ignored, including any of the never-saved settings above added
by hand.

If one step of an import fails, the sections before it stay imported and the
rest are not. Importing the same file again is safe: anything already imported
shows as no change.

## Remote hosts

While the window is connected to another computer through Remote Pane, the
card is disabled. Choose **This computer** in the sidebar's host switcher to
export or import this computer's setup.

## For teams

Run scripts a whole team should share belong in a committed
[`pane.json`](CONFIG_FILES.md), which every clone picks up. A setup file is for
moving one person's setup.

## File format

```json
{
  "kind": "pane-setup",
  "version": 1,
  "exportedAt": "2026-10-26T22:40:00.000Z",
  "appVersion": "2.4.202",
  "platform": "darwin",
  "sections": { "agentPresets": {}, "customCommands": [], "runScripts": [] }
}
```

`sections` holds only the sections chosen on export. Inside each, fields keep
their names from Pane's `config.json`; run scripts use `build_script`,
`run_script` and `archive_script`, and Preferences also carries the
`user_preferences` keys `auto_rename_sessions_to_pr`, `sidebar_pane_row_layout`,
`sidebar_attention_inbox`, `at_terminal_paste_mode` and `at_terminal_line_count`.
Readers ignore sections and keys they don't know, so a new section keeps
`version: 1`; the version changes only for a breaking change. The code is in
`main/src/services/setupTransfer.ts` and `shared/types/setupTransfer.ts`.
