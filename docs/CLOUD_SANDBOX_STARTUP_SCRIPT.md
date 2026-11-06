# Cloud sandbox startup script

A startup script sets up every cloud sandbox the same way: install a tool, clone a dotfiles repository, or
anything else you would otherwise do by hand after each start. It is one script for all of your sandboxes.

> **Don't put secrets here; it's stored unencrypted.** Sign in to tools that need a secret (for example
> `doppler login`, `gh auth login` or `codex login --device-auth`) yourself, in the sandbox's terminal.

## Where it is set and stored

- Edit it in **Settings > Remote Access > Cloud sandboxes > Startup script**. **Startup script** on a sandbox's
  row leads to the same editor.
- Desktop Pane keeps it only on this computer, as plain text: `<pane data dir>/cloud-sandboxes/startup.sh`
  (`~/.pane/cloud-sandboxes/startup.sh` by default, mode 0600).
- Each sandbox gets a copy at `~/.config/runpane-cloud/startup.sh` (mode 0700, owned by `user`). Pane pushes the
  current script when it creates a sandbox and every time it starts one, before it waits for the sandbox's Pane
  daemon. Saving an empty script removes the copy, and then nothing runs.
- `runpane cloud` never pushes a script: a sandbox started from the command line keeps the one it has.

## When it runs

- **On every start of the sandbox.** A systemd system unit, `rp-user-startup.service`, runs it as `user` at every
  boot, after the network is up (`Type=oneshot`, `After=network-online.target`). A stopped sandbox boots again when
  it starts, so this covers every **Start**.
- **Once after Create.** The new sandbox's row shows "Running your startup script…" while it runs.
- **Once after you save an edit**, on every running sandbox. A stopped sandbox gets the edit at its next start: the
  boot runs the copy it had, and Pane runs the script once more if you changed it since.
- The script runs with `bash`, from your home folder, without a terminal. `PATH` is the system path plus
  `~/.local/bin`. Your startup script runs as `user`, with passwordless sudo, so it can install packages and CLIs.
- It runs with the variables your local start script printed (see [Local start script](#local-start-script)).
- It never holds up Pane: the Pane daemon starts on its own, so the sandbox is usable while the script runs.

## Make it safe to run again

The script runs on every start, so a step that already happened must be skipped or harmless. That is up to you.
Guard installs, for example:

```bash
[ -d ~/dotfiles ] || git clone https://github.com/<you>/dotfiles ~/dotfiles
```

The Doppler CLI, for example, installs once and is skipped on later starts (see [Example: Doppler](#example-doppler)).

## Local start script

A local start script runs on **this computer**, not in the sandbox, each time a sandbox is created or started. Use it
to hand a sandbox values that live on your computer, such as a token your local Doppler CLI can read.

- **Where:** Settings > Remote Access > Cloud sandboxes > **Local start script**. On Windows, choose PowerShell or cmd;
  on macOS and Linux it runs with `sh`. Desktop Pane keeps it only on this computer, unencrypted, in
  `<pane data dir>/cloud-sandboxes/local-start.json` (mode 0600). Fetch secrets in it; don't paste them into it.
- **When:** on every create and every start, before the startup script runs. Saving it runs nothing and sends nothing:
  each sandbox gets the variables at its own next create or start.
- **Output:** every line it prints in the form `NAME=value` becomes a variable on THAT sandbox only, and no other one.
  Pane writes them to `~/.config/runpane-cloud/local-env` (mode 0600) as `export NAME='value'` lines, quoted so that
  reading the file never runs anything. Other lines are ignored. A value is one line.
- **Who sees them:** the startup script, terminals (`~/.bashrc`), login shells (`~/.profile`), and every `bash` the
  sandbox's agents run, such as Claude Code's and Codex's commands (`BASH_ENV`, set for the Pane daemon).
- **Reserved names are skipped:** `PATH`, `HOME`, `USER`, `SHELL`, `BASH_ENV`, `ENV`, `IFS`, `GITHUB_TOKEN`, and
  names starting with `LD_`, `GIT_`, `SSH_`, `PANE_`, `RUNPANE_`, `CLAUDE_`, `ANTHROPIC_` or `GH_`, so a script
  can't change how the sandbox runs or signs in. The sandbox's row lists the skipped names.
- **Secrets:** values are never shown, logged or put in a message. Logs and the row show variable names only.
- **Failures:** the script is stopped after 60 seconds. A non-zero exit, a timeout, or a script that can't start
  shows on the sandbox's row ("⚠ Local start script failed (exit N)", "⚠ Local start script timed out after 60 s").
  The sandbox stays usable and keeps the variables it had, because a fetch that failed shouldn't wipe values that still
  work. Clearing the script, or a run that prints no variables, removes them at the next create or start.
- **The startup script runs again when they change:** on Start, the boot already ran your startup script with the
  variables the sandbox had. If the local start script brought different ones, or the startup script changed, it runs
  once more with the new ones.

## Example: Doppler

The startup script installs the Doppler CLI once:

```bash
command -v doppler >/dev/null 2>&1 || {
  sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg &&
  curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/doppler-archive-keyring.gpg &&
  echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" | sudo tee /etc/apt/sources.list.d/doppler-cli.list >/dev/null &&
  sudo apt-get update && sudo apt-get install -y doppler
}
```

The local start script hands each sandbox your Doppler token. macOS and Linux (`sh`):

```sh
echo "DOPPLER_TOKEN=$(doppler configure get token --plain)"
```

Windows (PowerShell):

```powershell
"DOPPLER_TOKEN=$(doppler configure get token --plain)"
```

In the sandbox, `doppler` then reads `DOPPLER_TOKEN`, for example `doppler run -- <command>` in a terminal.

## Logs and failures

- `~/.local/state/runpane-cloud/startup.log` holds the output of the latest run. `startup.log.1` to `startup.log.4`
  keep the 4 runs before it, so the last 5 runs are kept.
- `~/.local/state/runpane-cloud/startup-status.json` describes the latest run: `exitCode`, `startedAt`, `finishedAt`,
  the script's `sha256` and `timedOut`. While a run is in progress, `exitCode` and `finishedAt` are `null`.
- After Create, Start or a saved edit, Pane reads the status. When the script exits with a non-zero code, the row
  shows **⚠ Startup script failed (exit N) · View log**; when it ran too long, **(timed out after 10 min)**.
  **View log** shows the last 200 lines of the latest run. The sandbox stays usable either way.
- The log holds whatever your script prints, so don't print secrets from it either.

## Known limits

- **10 minutes per run.** After that the script is stopped and the run counts as failed (timed out).
- **No background services.** Processes the script leaves running are stopped when it finishes. Run a long-lived
  process as a systemd user service instead.
- **No input.** The script has no terminal and its input is empty, so a command that asks a question gets no answer:
  pass its non-interactive flag (for example `apt-get -y`).
- **The failure chip is kept in memory only.** A row shows the run the desktop read after Create, Start or an edit.
  Pane doesn't watch later runs, and the chip is not kept across a desktop restart: it comes back at the next Start
  or edit. The sandbox's `startup-status.json` and logs always have the latest run.
- **Plain text.** The script is not encrypted on this computer or in the sandbox.
- **Local start script values are one line each,** and Windows PowerShell may change non-ASCII characters in them.
- **Agents' own processes** get the variables only through the shells they run. On a sandbox created before the local
  start script existed, agents' shells see them after the Pane daemon next restarts (for example after Update Pane).
