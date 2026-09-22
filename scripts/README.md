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

Contrast and colour-vision-deficiency gate for Pane themes. Chromium loads
`frontend/src/styles/tokens/colors.css` and resolves the real cascade, variables,
and colours with computed styles. One engine measures WCAG 2.x contrast for
text, UI and terminal ANSI pairs, and simulates protanopia, deuteranopia and
tritanopia (Machado 2009) for status, diff and ANSI palettes. It runs without
starting Pane, Vite, or any network requests.

```bash
pnpm exec playwright install chromium # once locally; CI already installs Chromium
pnpm theme:contrast                    # enforce the complete contrast contract
pnpm theme:contrast -- --themes folio,colorblind-safe
pnpm theme:contrast -- --all --verbose # report every theme without failing thresholds
pnpm theme:contrast -- --markdown --cvd
```

All themes enforce AA muted text and AAA muted text in high-contrast mode.
The fifteen themes in `GATED_THEMES` also enforce their designed text, UI,
terminal and status profiles, including high-contrast variants. `strictUi`
adds the accessibility family's hairline pairs; `cvd` enforces CVD separation.
Folio, Newsprint and Walnut additionally check every editorial text surface,
button state and terminal/editor background equality, and require explicit
overrides for the base theme tokens. Other pairs remain informational for the
original twelve themes. `--all` reports all thresholds without failing them;
missing Chromium, invalid themes and other execution errors still fail.

Add themes to the canonical `THEME_CLASSES` in `shared/types/appearance.ts` and
add their full profile to `GATED_THEMES`. Vite also embeds that canonical map
and the default appearance directly into the synchronous HTML bootstrap in
dev and production; no second map or runtime fetch is needed. CI runs the
contrast gate and the appearance bootstrap browser journeys.

Typography uses locally installed fonts and the existing system monospace
fallbacks. The renderer stylesheet must not import runtime font CDNs: a failed
nested stylesheet request can reject Vite's CSS preload and prevent startup.
