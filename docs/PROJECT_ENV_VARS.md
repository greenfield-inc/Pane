# Project environment variables

A project can define environment variables that Pane sets in everything it starts
for that project's Panes: terminal panels, agent panels (Claude, Codex, Cursor or a
custom command), and the setup, run (Play) and archive scripts. Panes of other
projects never get them, and nothing is exported in your global shell.

Edit them in **Project Settings → Environment Variables**. Changes apply to
terminals and scripts started after you save; a terminal that is already open keeps
the environment it started with.

## Plain text or keychain

Each variable is one of:

| Source | What Pane stores |
| --- | --- |
| Plain text | The value, in the Pane database |
| macOS Keychain, new secret | Only a reference to the item Pane creates: service `Pane`, account `<projectId>:<NAME>` |
| macOS Keychain, existing item | Only the service and account of a generic-password item you already have |

Keychain values are read each time a process starts, so a changed item applies to
the next terminal. A keychain value is never written to the Pane database, logs or
analytics, and never sent to the Project Settings window: once saved it shows as
`••••••••` with a **Replace** button. Pane runs `/usr/bin/security` to read and
write items, passing a new secret on stdin rather than the command line.

A Pane started with a different data directory (`PANE_DIR` or `--pane-dir`, as dev
builds are) names its items `Pane (<data directory>)` instead, so two instances never
share or delete each other's items.

When you remove a keychain variable or delete the project, Pane deletes the item it
created for it (renaming the variable keeps the item). It never deletes an item you
referenced, even one named like Pane's own.

Referencing an item another app created (for example one Conductor stored) makes
macOS ask whether `security` may read it the first time; choose **Always Allow** so
later terminals open without asking. A read that waits more than 60 seconds is
treated as failed.

Keychain variables work only when the Pane host runs macOS. On another host (for
example a Linux remote daemon), saving one is refused with `KEYCHAIN_UNSUPPORTED`;
use a plain value there.

### Who can read the value

The keychain keeps the value out of your shell profile, Pane's files and other
projects' Panes. It is not a sandbox:

- Every process Pane starts for the project, including the agents, gets the value in
  its environment, and other processes running as your user can read a process's
  environment (for example with `ps eww`).
- Items Pane creates trust `/usr/bin/security`, and so does an item you allowed with
  **Always Allow**. Any process running as your user can read them through
  `security find-generic-password` without a prompt while the login keychain is
  unlocked.

## Names and precedence

Names use letters, digits and underscores and do not start with a digit. `PATH`,
`WORKTREE_PATH` and anything starting with `PANE_` are reserved: Pane always sets
them itself, so a project cannot override them. A project variable overrides the
same name inherited from the environment Pane was started in, and the `TERM`,
`COLORTERM` and `LANG` defaults Pane gives terminals. Your shell's startup files run
after that, so an `export` in `~/.zshrc` still wins inside a terminal.

In WSL projects the variables are added to `WSLENV`, so they reach the Linux shell.

## When a keychain item cannot be read

The terminal or script still starts, without that variable. After the shell's first
prompt, the terminal shows a `[Pane]` line naming the variable, the item and the
keychain's reason; setup and archive scripts write the same line to the Pane's logs.
The value is never printed. Fix the item in Keychain
Access (unlock the keychain, or allow access) or change the variable in Project
Settings, then open a new terminal.

## Example

A repository's `.mcp.json` reads `${UIVERIFY_API_KEY}`. Add `UIVERIFY_API_KEY` to
that project as a keychain variable (a new secret, or an existing item's service and
account), and every agent started in one of its Panes sees it, while other projects
and your login shell do not.
