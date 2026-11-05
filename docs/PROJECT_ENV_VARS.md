# Project environment variables

A project can define environment variables that Pane sets in everything it starts
for that project's Panes: terminal panels, agent panels (Claude, Codex, Cursor or a
custom command), and the setup, run (Play) and archive scripts. Panes of other
projects never get them, and nothing is exported in your global shell.

Edit them in **Project Settings → Environment Variables**. Changes apply to
terminals and scripts started after you save; a terminal that is already open keeps
the environment it started with.

## Plain text, Pane secret or keychain item

Each variable is one of:

| Source | What the project stores |
| --- | --- |
| Plain text | The value, in the Pane database |
| Pane secret | Only the secret's address, `<project>/<NAME>`. The value lives in [Pane secrets](PANE_SECRETS.md), so every repo and agent that uses it shares one copy, synced to your other machines. |
| macOS Keychain | Only the service and account of a generic-password item you already have (macOS hosts only) |

For a Pane secret row, type a value to create or replace that secret when you save;
leave it empty to use the secret as it is. The project defaults to the repo's name
and the secret's name to the variable's. Once saved, the value shows as `••••••••`
with a **Replace** button, and is never sent back to the Project Settings window.

Pane secrets and keychain values are read each time a process starts, so a changed
secret applies to the next terminal. A value is never written to the Pane database,
logs or analytics. Removing a variable, or deleting the project, leaves the Pane
secret or keychain item in place; delete a secret in Settings → Secrets.

Referencing an item another app created (for example one Conductor stored) makes
macOS ask whether `security` may read it the first time; choose **Always Allow** so
later terminals open without asking. A read that waits more than 60 seconds is
treated as failed. Keychain variables work only when the Pane host runs macOS; on
another host saving one is refused with `KEYCHAIN_UNSUPPORTED`. Use a Pane secret
there.

`runpane repos get` shows a repo's variables (plain values in full, the rest as
references) and `runpane repos update --env '<json>' --env-remove NAME --yes`
changes them. It never takes a secret value: set one with `runpane secrets set` and
reference it by project and name.

### Who can read the value

Pane secrets and the keychain keep values out of your shell profile, Pane's files and
other projects' Panes. They are not a sandbox:

- Every process Pane starts for the project, including the agents, gets the value in
  its environment, and other processes running as your user can read a process's
  environment (for example with `ps eww`).
- Any agent can use any Pane secret through `runpane secrets exec`
  ([who can read a secret](PANE_SECRETS.md#who-can-read-a-secret)).
- On a host set to "Everyone on tailnet", a teammate's commands and terminals run as
  you and can reach every secret. Pane only keeps the secret and keychain variables
  out of the terminals and scripts they start.
- An item you allowed with **Always Allow** trusts `/usr/bin/security`, so any
  process running as your user can read it without a prompt while the login
  keychain is unlocked.

## Names and precedence

Names use letters, digits and underscores and do not start with a digit. `PATH`,
`WORKTREE_PATH` and anything starting with `PANE_` are reserved: Pane always sets
them itself, so a project cannot override them. A project variable overrides the
same name inherited from the environment Pane was started in, and the `TERM`,
`COLORTERM` and `LANG` defaults Pane gives terminals. Your shell's startup files run
after that, so an `export` in `~/.zshrc` still wins inside a terminal.

In WSL projects the variables are added to `WSLENV`, so they reach the Linux shell.

## When a value cannot be read

The terminal or script still starts, without that variable. After the shell's first
prompt, the terminal shows a `[Pane]` line naming the variable, the secret or item,
and the reason (a missing secret, a locked keychain); setup and archive scripts
write the same line to the Pane's logs. The value is never printed. Set the secret
in Settings → Secrets, fix the item in Keychain Access, or change the variable in
Project Settings, then open a new terminal.

## Example

A repository's `.mcp.json` reads `${UIVERIFY_API_KEY}`. Add `UIVERIFY_API_KEY` to
that project as a Pane secret (type the value, or point it at a secret you already
have, such as `qa/UIVERIFY`), and every agent started in one of its Panes sees it,
while other projects and your login shell do not.
