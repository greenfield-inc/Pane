# Scripts Directory

This directory contains build and maintenance scripts for the Pane application.

## benchmark-session-output.js

Compares loading terminal history just to count it with an indexed SQLite
count on a temporary 10,000-row database. Reports median read time and heap
growth, then deletes the fixture.

```bash
pnpm build:main
node --expose-gc scripts/benchmark-session-output.js
```

See [the session output audit](../docs/SESSION_OUTPUT_PERFORMANCE.md) for
results, regression checks, and measurement limits.

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

- Automatically runs during `pnpm run build:mac` and `pnpm run release:mac`
- Should be run whenever dependencies change
- CI/CD runs this in the license-compliance workflow

### License compliance

The script helps ensure Pane complies with open source license requirements by:
- Including all third-party license texts in distributions
- Identifying packages with missing license information
- Supporting the license-compliance GitHub workflow

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
report-only so existing debt does not block CI. Each gated theme carries the
profile its family was designed to (`body` / `ui` / `terminal` / `status`
minimums; `strictUi` adds the hairline pairs — 1px input border, scrollbar
thumb, subtle focus ring — that only the accessibility family commits to;
`cvd` gates the colour-vision simulation). Add a theme to `THEME_CLASSES` (and
to `GATED_THEMES` when it should be enforced) when adding one to
`themeContextValue.ts`.
