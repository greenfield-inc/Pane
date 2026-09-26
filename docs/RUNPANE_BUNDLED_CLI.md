# Bundled runpane on terminal PATH

Every terminal Pane launches (Session orchestrators, agent panels, plain
terminals, and run scripts) can call `runpane` without a global install. The
command always matches the running Pane build.

## How it works

- `pnpm build:main` bundles `packages/runpane/src/cli.ts` into
  `main/dist/runpane/runpane.cjs` (`main/build-runpane-cli.js`). It ships
  inside the app with the rest of `main/dist`, and `pnpm dev` builds it
  through `pnpm build:main`.
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
  - **WSL terminals** are unchanged. The Windows Electron binary cannot run
    inside the distro. Install `runpane` in the distro, or use
    `npx --yes runpane@latest`.

## Existing global installs

A globally installed `runpane` (`npm i -g runpane`) still works in other
terminals. Inside Pane terminals, Pane's shim resolves first because it
matches the running build's local-control contract. Use `$PANE_RUNPANE_BIN`
to call it by absolute path.

Several Pane builds that share one `PANE_DIR` (for example a dev build and
the installed app, both on `~/.pane`) rewrite the same shim at startup; the
most recently started build wins. Use `PANE_DIR=~/.pane_test pnpm dev` to keep
them apart.
