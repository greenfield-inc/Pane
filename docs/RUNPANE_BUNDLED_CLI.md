# Bundled runpane on terminal PATH

Every terminal Pane launches (Session orchestrators, agent panels, plain
terminals, and run scripts) can call `runpane` without a global install. The
command always matches the running Pane build. The installed app also adds the
same command to the end of your own `PATH`, so it works in any terminal.

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
- If that Electron binary is gone (a failed update, or the app was moved), the
  shim runs the CLI with `node` from `PATH` instead. Without `node`, it prints
  one line: reinstall Pane from https://runpane.com, or install Node.js and
  run `npx --yes runpane@latest update`. When Pane is not running,
  `runpane update` installs the latest release instead of updating in place,
  so it works in this state.
- The shim checks only that the binary exists and is executable. If the
  binary exists but crashes on launch, `runpane` fails with it; run
  `npx --yes runpane@latest update` to reinstall Pane.
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

## Every other terminal

At startup, the installed Pane appends `<PANE_DIR>/bin` (normally
`~/.pane/bin`) to the end of your own `PATH`. It appends rather than prepends,
so a `runpane` you installed with npm keeps winning outside Pane.

- **macOS and Linux:** Pane appends a block marked `pane-runpane-path v1` to
  the startup files of your login shell. The block adds the directory only if
  `PATH` does not already contain it.
  - zsh: `~/.zshenv` (created if missing), which zsh reads in every shell
  - bash: `~/.bashrc`, plus `~/.bash_profile` on macOS
  - fish: `~/.config/fish/conf.d/pane.fish`
  - On macOS, an existing `~/.bash_profile` also gets the block when your
    login shell is not bash.

  Pane skips a file that is a symbolic link or already mentions the directory.
  New terminals pick it up; run `exec $SHELL -l` in an open one.
- **Windows:** Pane appends the directory to your user `PATH`
  (`HKCU\Environment\Path`, no administrator rights), keeping the value's
  type (`REG_EXPAND_SZ` or `REG_SZ`), and broadcasts `WM_SETTINGCHANGE`.
  Terminals opened afterwards find `runpane`; already open ones keep their
  old `PATH`.
- **WSL:** unchanged. Windows `PATH` changes do not reach the distro.
- **Remote daemon hosts** (`runpane install daemon`): unchanged. Only the
  desktop app edits `PATH`; on a server, install `runpane` with npm.

Pane changes each file, and the Windows `PATH`, at most once, and records
what it changed in `<PANE_DIR>/bin/user-path.json`. Pane skips all of this when
`PANE_DISABLE_OS_INTEGRATION=1` is set, when it runs with a non-default data
directory (`--pane-dir`, `PANE_DIR` or `FOOZOL_DIR`), and in development
builds.

To remove it, delete the lines from `# pane-runpane-path v1` through
`# end pane-runpane-path v1` (or delete `pane.fish`). On Windows, remove the
`.pane\bin` entry under Settings > System > About > Advanced system settings >
Environment Variables > User variables > Path. Pane does not add it again.

## Existing global installs

A globally installed `runpane` (`npm i -g runpane`) still wins in other
terminals, because Pane appends its directory after it. Inside Pane terminals, Pane's shim resolves first because it
matches the running build's local-control contract. Use `$PANE_RUNPANE_BIN`
to call it by absolute path.

Several Pane builds that share one `PANE_DIR` (for example a dev build and
the installed app, both on `~/.pane`) rewrite the same shim at startup; the
most recently started build wins. Use `PANE_DIR=~/.pane_test pnpm dev` to keep
them apart.
