# Bundled runpane on terminal PATH

Every terminal Pane launches (Session orchestrators, agent panels, plain
terminals, and run scripts) can call `runpane` without a global install. The
command always matches the running Pane build.

## How it works

- `pnpm build:main` bundles `packages/runpane/src/cli.ts` into
  `main/dist/runpane/runpane.cjs` (`main/build-runpane-cli.js`). It ships
  inside the app with the rest of `main/dist`, and `pnpm dev` builds it
  through `pnpm build:main`. The bundle embeds its version and docs search
  index, so both still work after the single file is copied out of the app.
- At startup (`createPaneDaemonHost`, which both the desktop app and the
  headless daemon use), Pane copies that file to `<PANE_DIR>/bin/runpane.cjs`
  and writes a `<PANE_DIR>/bin/runpane` shim (plus `runpane.cmd` on Windows).
  The shim runs the CLI with Pane's own Electron binary as Node
  (`ELECTRON_RUN_AS_NODE=1`) and defaults `PANE_DIR` to that Pane data
  directory. Files are rewritten only when their content changes. Pane never
  follows a symbolic link there or overwrites a file it did not write.
- Terminal launches put `<PANE_DIR>/bin` first on `PATH` and export
  `PANE_RUNPANE_BIN` with the shim's absolute path. User startup files can
  rebuild `PATH`, so supported shells re-apply it afterwards:
  - **zsh:** `ZDOTDIR` points at `<PANE_DIR>/shell/zsh`. Each wrapper file
    sources the user's matching file from their own `ZDOTDIR` (or `$HOME`),
    then the last one moves `<PANE_DIR>/bin` to the front and restores the
    user's `ZDOTDIR`. A `precmd` hook keeps it first when tools such as direnv
    or nvm edit `PATH` before a prompt. History stays in the user's
    `.zsh_history`.
  - **bash:** `--rcfile <PANE_DIR>/shell/bash/rcfile` sources
    `/etc/bash.bashrc` and `~/.bashrc` (what an interactive non-login bash
    normally reads), then moves the directory to the front and adds a
    `PROMPT_COMMAND` hook.
  - **fish:** `--init-command` runs after the user's config and adds a
    `fish_prompt` handler.
  - **Other shells, Windows, and run scripts:** `PATH` is prepended only.
  - **WSL terminals:** see below.

## WSL terminals

On Windows, WSL terminals use the same `<PANE_DIR>/bin/runpane` shim, read
from the distro as `/mnt/c/...`. Nothing is installed in the distro.

- The daemon listens on a Windows named pipe, which Linux processes cannot
  open (a distro `node` gets `ENOENT`). So inside WSL (`WSL_DISTRO_NAME` is
  set) the shim runs Pane's Windows Electron binary through WSL interop, with
  `ELECTRON_RUN_AS_NODE` and `PANE_DIR` added to `WSLENV`. The CLI is then a
  Windows process on the same pipe as Windows terminals. A call takes about
  0.4 s.
- Pane already lists the terminal's `PANE_*` variables in `WSLENV`, so they
  reach the CLI. Its working directory is the Windows form of the shell's
  (`\\wsl.localhost\<distro>\...`, or `C:\...` under `/mnt/c`).
- WSL terminals start bash with `--rcfile <PANE_DIR>/shell/bash/wsl-rcfile`
  instead of `--login`. The rcfile reads the files a login bash reads
  (`/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login`,
  `~/.profile`), then puts the bin directory (via `wslpath -u`) first on
  `PATH`, exports `PANE_RUNPANE_BIN`, and adds a `PROMPT_COMMAND` hook. The
  shell is interactive but not a login shell, so use `exit`, not `logout`. If
  the distro cannot read the rcfile, the terminal starts `bash --login` as
  before.
- With interop off, `runpane` prints how to turn it back on (`[interop]
  enabled=true` in `/etc/wsl.conf`) and exits 126.
- A Windows command line is limited to 32,767 characters. Pass long text with
  a file flag such as `--prompt-file` instead of inline.
- WSL Sessions keep their own `.pane-runtime/runpane` bridge
  ([SESSIONS.md](SESSIONS.md)).

## Existing global installs

A globally installed `runpane` (`npm i -g runpane`) still works in other
terminals. Inside Pane terminals, Pane's shim resolves first because it
matches the running build's local-control contract. Use `$PANE_RUNPANE_BIN`
to call it by absolute path.

Several Pane builds that share one `PANE_DIR` (for example a dev build and
the installed app, both on `~/.pane`) rewrite the same shim at startup; the
most recently started build wins. Use `PANE_DIR=~/.pane_test pnpm dev` to keep
them apart.
