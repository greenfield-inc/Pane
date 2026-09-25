# Scripts Directory

This directory contains build and maintenance scripts for the Pane application.

## benchmark-cold-start.mjs

Launches the built app repeatedly and reports p50/p75 of wall time from spawn
to each startup step (main JS running, Electron ready, services up, index.html
loaded, sidebar on screen) and the main thread's CPU time to ready and to
index.html loaded. Pass several builds of `main/dist` to compare them; rounds
alternate between them.

```bash
pnpm build:frontend && pnpm build:main   # native modules built for Electron
cp -R main/dist main/dist-before          # or build another commit there
node scripts/benchmark-cold-start.mjs 20 before=main/dist-before after=main/dist
```

Uses an isolated Pane directory, profile and HOME under
`~/.pane_bench_cold_start.noindex` (`PANE_BENCH_DIR`) and CDP port 4160 (`PORT`).

## benchmark-session-output.js

Compares loading terminal history just to count it with an indexed SQLite
count on a temporary 10,000-row database. Reports median read time and heap
growth, then deletes the fixture.

```bash
pnpm build:main
node --expose-gc scripts/benchmark-session-output.js
```

Results and measurement limits are in the PR that added it (#592).

## benchmark-terminal-emulation.js

Streams full-screen agent-style frames into 8 headless terminal models at
60 fps and reports how busy that keeps the calling thread: event-loop busy
percent and heartbeat lateness (event-loop delay). `inline` parses on the
calling thread, `worker` uses the terminal emulator thread, and `none` drops
the output to show the harness's own floor.

```bash
pnpm build:main
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/benchmark-terminal-emulation.js
```

`PANES` and `SECONDS` override the defaults (8 and 10).

## benchmark-webgl-atlas.js

Opens one xterm with the WebGL renderer and prints GPU and renderer memory,
frame rate, the longest frame gap, and glyph atlas merges and full resets once
a second, then a summary. `WORKLOAD=shimmer` (default) repaints every cell in a
24-bit color it has not used before, the worst case of an agent's animated
gradient; `WORKLOAD=normal` scrolls colored log lines under a cycling
"Thinking…" gradient. On macOS memory comes from `footprint`, which counts the
graphics memory that Electron's own metrics leave out.

```bash
node_modules/.bin/electron scripts/benchmark-webgl-atlas.js
```

`DURATION` sets the run length in seconds (default 90). `ATLAS_CAP` swaps the
patched 4096 px page cap for another size. `WEBGL_ADDON` points at another
`addon-webgl.js` build, for example an unpatched copy from
`npm pack @xterm/addon-webgl@<version>`. `RECORD=<file>.webm` saves a video of
the terminal canvas plus the atlas reset times, to check frames for flashing
glyphs.

## benchmark-git-worktree-config.mjs

Builds a 100,000-file repository with a Pane-style worktree, edits a file, and
times the git commands behind Pane's status refresh, Diff tab, and a plain
`git status`. It runs with default git config, with the config
Pane writes (`feature.manyFiles`, plus `core.fsmonitor` where Git has the
built-in daemon), and with that config plus `GIT_OPTIONAL_LOCKS=0`, then
prints the median of each.

```bash
node scripts/benchmark-git-worktree-config.mjs
```

`FILES` and `RUNS` override the defaults (100000 and 10).

## ci-background.sh

Lets a GitHub Actions job run a command in the background while later steps
continue. A `start` step launches the command; a later `wait` step prints its
output and fails the job if the command failed. `.github/workflows/quality.yml`
uses it to run type checking, lint, and the Playwright install beside other
steps.

```bash
scripts/ci-background.sh start typecheck pnpm typecheck
scripts/ci-background.sh wait typecheck
```

## generate-notices.js

Generates a NOTICES file containing all third-party licenses for dependencies included in the Pane distribution.

### Usage

```bash
# Generate NOTICES file
pnpm run generate-notices

# Or run directly
node scripts/generate-notices.js
```

### How it works

1. Scans all node_modules directories in the workspace
2. Collects license information from LICENSE files and package.json
3. Excludes development-only dependencies that aren't distributed
4. Creates a NOTICES file in the project root

### When to run

- Automatically runs in the `build:mac*`, `build:linux*`, `release:mac*` and
  `release:linux` scripts, and in `scripts/build-win.js` for Windows builds
- Should be run by hand whenever dependencies change

### License compliance

The script helps ensure Pane complies with open source license requirements by:
- Including all third-party license texts in distributions
- Identifying packages with missing license information

## check-theme-contrast.mjs

Contrast and colour-vision-deficiency gate for Pane themes. Parses
`frontend/src/styles/tokens/colors.css`, composes each theme's tokens the way
`ThemeProvider` composes classes, and measures WCAG 2.x contrast for text,
UI (3:1) and terminal ANSI pairs. Simulates protanopia, deuteranopia and
tritanopia (Machado 2009 matrices) for the status, diff and ANSI palettes.

```bash
pnpm theme:contrast                    # gate every theme in GATED_THEMES (the 15 batch themes)
pnpm theme:contrast -- --all --verbose # report every theme (report only, always exit 0)
pnpm theme:contrast -- --markdown --cvd
```

Only the themes in `GATED_THEMES` fail the exit code; every other theme is
report-only so existing debt does not fail the run. CI does not run this
script. Each gated theme carries the
profile its family was designed to (`body` / `ui` / `terminal` / `status`
minimums; `strictUi` adds the hairline pairs — 1px input border, scrollbar
thumb, subtle focus ring — that only the accessibility family commits to;
`cvd` gates the colour-vision simulation). The script keeps its own copy of
`THEME_CLASSES`. When adding a theme to `THEME_CLASSES` in
`shared/types/appearance.ts`, add it to the script's copy too (and to
`GATED_THEMES` when it should be enforced).

## build-win.js

Builds the Windows installer. Downloads the Electron prebuilt for
`better-sqlite3-multiple-ciphers`, builds the app, generates notices, and runs
electron-builder with native rebuilds off. See
[Building on Windows](../docs/BUILDING_ON_WINDOWS.md).

```bash
pnpm build:win:x64
pnpm build:win:arm64
```

## generate-runpane-contract.js

Validates `contracts/runpane/contract.json` and generates the `runpane`
wrappers' contract files, the parser fixture, and
`docs/RUNPANE_CLI_CONTRACT.md` from it. `--check` fails if any generated file
is out of date.

```bash
pnpm generate-runpane-contract
pnpm check:runpane-contract
```

## pane-remote-setup.js

Sets up this checkout as a remote Pane host. Builds `main` first if needed,
then runs the same setup as `pane --remote-setup`. Pass options after `--`.

```bash
pnpm remote:setup -- --help
```

## pane-run-script.js

The dev launcher behind `pnpm dev`. Picks a free port per worktree, installs
dependencies or rebuilds native modules when they are stale, then starts the
main-process watcher, Vite, and Electron. `pnpm perf:scan` runs it with
`--react-scan` to turn on React Scan.

```bash
pnpm dev
pnpm perf:scan
```

## release.js

Bumps the version, creates the release commit and tag, and pushes them. Run it
from a clean worktree whose HEAD matches `origin/main`. See
[the release runbook](../RUNBOOK.md).

```bash
pnpm release patch   # or minor, major, or an exact x.y.z
```

## sync-runpane-package-versions.js

Sets the root, npm `runpane`, and PyPI `runpane` package versions to one value.
`--check` fails if they differ. `release.js` runs it for you.

```bash
node scripts/sync-runpane-package-versions.js 1.2.3
pnpm check:runpane-package-versions
```
