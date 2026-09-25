# Contributing to Pane

Thank you for your interest in contributing to Pane! We welcome contributions from the community and are excited to work with you.

Pane is an open source project created by [Dcouple Inc](https://dcouple.ai). Dcouple builds AI software focused on decoupling humans from interfaces to make work feel less like work and more like thought.

## Right to Contribute this Code
- You represent and warrant that You are legally entitled to contribute the code you contribute to Pane
- You represent and warrant that each of Your Contributions is Your original creation. You represent and warrant that, to Your knowledge, none of Your Contributions infringe, violate, or misappropriate any third party intellectual property or other proprietary rights.

## Getting Started

You need Node 22.18 or newer and pnpm 10. `corepack enable` picks up the pnpm
version pinned in `package.json`.

1. Fork the repository on GitHub and clone your fork.
2. Install dependencies, rebuild native modules for Electron, and build the
   main process:
   ```bash
   pnpm run setup
   ```
3. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Running the App

```bash
PANE_DIR=~/.pane_test pnpm dev
```

`pnpm dev` starts Vite, the main-process TypeScript watcher and Electron. It
re-bundles the preload script whenever the watcher overwrites it and rebuilds
native modules for Electron when needed. Use it rather than
`pnpm electron-dev`, which does neither and exists for Playwright's web server.

Development runs write renderer and main-process output to `frontend-debug.log`
and `backend-debug.log` in the repository root. Both are reset at startup.

### Running a dev build safely

A dev build is the same app as an installed Pane, and by default it shares that
install's data:

- **Pane data** (`sessions.db`, `config.json`, skills) lives in `~/.pane`
  unless you set `PANE_DIR` or pass `--pane-dir`. Always set one for `pnpm dev`,
  Playwright runs and scripts. Keep the path short, like `~/.pane_test`: a long
  path pushes Pane's Unix sockets past their 104-character limit.
- **Electron's browser profile** (localStorage, cache, cookies) is not covered
  by `PANE_DIR`. An unpackaged build uses the same profile folder as the
  installed app (`~/Library/Application Support/Pane` on macOS). `pnpm dev`
  and `pnpm electron-dev`, and therefore Playwright, can't change it. To isolate
  it, build once and launch Electron yourself with `--user-data-dir`:
  ```bash
  pnpm run build:frontend && pnpm run build:main
  NODE_ENV=production pnpm exec electron . \
    --pane-dir="$HOME/.pane_test" \
    --user-data-dir="$HOME/.pane_test/chromium-user-data"
  ```
  `NODE_ENV=production` loads the built renderer from `frontend/dist`, so no
  Vite server is needed. Rebuild after changes.
- **Analytics** are on by default in a fresh data directory. To keep test runs
  out of the product analytics, create `<PANE_DIR>/config.json` with
  `{"analytics": {"enabled": false}}` before the first launch.
- A copy of a real `sessions.db` makes the dev build reconcile reserve worktrees
  in the real repositories it lists. Use a fresh data directory unless you need
  real data.

### Native modules

`better-sqlite3-multiple-ciphers` is compiled for one runtime at a time.
Vitest runs on Node and the app runs on Electron, so switch between them:

```bash
npm rebuild better-sqlite3-multiple-ciphers   # before main unit tests
pnpm electron:rebuild                         # before running the app again
```

`pnpm dev` does the Electron rebuild for you when it's needed. A batch of main
tests failing with `NODE_MODULE_VERSION` means the module is built for the wrong
runtime, not that your change broke something.

## Tests

```bash
pnpm typecheck
pnpm lint
pnpm --filter frontend test
pnpm --filter main exec vitest run
pnpm test:ci:minimal
```

- `pnpm --filter main test` runs Vitest in watch mode; use `exec vitest run`
  for a single pass, as CI does. Main tests live next to the code as
  `*.test.ts`.
- Vitest points `PANE_DIR` at a temporary directory, so unit tests never touch
  your real data.
- Playwright tests live in `tests/*.spec.ts`. Install the browser once with
  `pnpm exec playwright install chromium`. `pnpm test:ci:minimal` runs the suite
  CI runs: smoke, health check, accessibility and settings.
- Playwright starts the dev app (`pnpm electron-dev`) as its web server on port
  `4521`. Set `PANE_DIR` for the run. Don't run two Playwright commands on the
  same port at once: the second can attach to or kill the first one's server.
  Use `PLAYWRIGHT_PORT` to separate them:
  ```bash
  PANE_DIR=~/.pane_test PLAYWRIGHT_PORT=4522 pnpm test -- tests/smoke.spec.ts
  ```
- Add Playwright tests for user-visible flows, and mock external services
  where you can.

## Debugging

- Main-process crash traces cite `main/dist/main/src/**/*.js`, not the
  TypeScript source. Build `main/` (`pnpm --filter main build`) and read the
  cited line and column in `dist`. Don't compile a single file on its own: the
  line numbers shift.
- `pnpm perf:scan` runs the dev app with React Scan and prints
  `[render-evidence]` summaries. React Scan never ships in production builds.
- To measure dropped frames while terminal output streams, see the header of
  `tests/terminal-frames.perf.spec.ts`.

## Code Style

- TypeScript throughout; no explicit `any` (use a specific type, or `unknown`
  with narrowing).
- `pnpm lint` runs Oxlint, Knip, the remaining ESLint rules and the advisory
  anti-slop scan. Blocking lint is the floor for new code. See
  [docs/lint/anti-slop.md](docs/lint/anti-slop.md) and
  [docs/lint/oxlint-overlap.md](docs/lint/oxlint-overlap.md).
- Two-space indentation. `camelCase` for variables and functions, `PascalCase`
  for React components and types, `kebab-case` for other filenames.
- There is no formatter or commit hook; follow the surrounding code.

## Making Changes

### Before You Start

1. Check existing issues to avoid duplicates.
2. For significant changes, open an issue first to discuss.
3. Make sure your branch is up to date with `main`.

### Commit Guidelines

- Write clear, concise commit messages in the present tense ("Add feature", not "Added feature").
- Keep commits focused, and reference issues when applicable ("Fix diff flicker, closes #123").

### Pull Request Process

1. Update or delete any doc your change makes wrong (see the docs rule in
   [AGENTS.md](AGENTS.md#docs)).
2. Add tests for new functionality, and make sure `pnpm typecheck`, `pnpm lint`
   and the tests pass.
3. If you added or updated dependencies, run `pnpm run generate-notices` and
   commit the updated `NOTICES` file.
4. Open the pull request with a clear description, linked issues, the commands
   you ran, and screenshots for UI changes.

CI runs typecheck, lint, a markdown link check, unit tests on Linux, macOS and
Windows, and the Playwright smoke suite. React Doctor also comments on new React
findings in `frontend/`; it is advisory. To see its findings before you push:

```bash
pnpm exec react-doctor frontend --scope changed
```

Maintainers attach PR screenshots by uploading them to the `pr-assets` release
(`gh release upload pr-assets <file> --clobber`, named
`pr-<number>-<name>-<hash>.png`) and linking the release download URL.

Releases, CI and deploys are covered in [RUNBOOK.md](RUNBOOK.md).

### Manual Testing

Test UI and packaging changes in a packaged build for your platform
(`pnpm build:mac`, `pnpm build:linux` or `pnpm build:win:x64`; output in
`dist-electron/`). The packaged app can show problems that development mode
hides. Check that you can create a pane, run an agent, use git operations and
run scripts, and that settings persist after a restart.

## Reporting Issues

When reporting issues, please include:
- Pane version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- Relevant error messages

## Feature Requests

We love hearing ideas for new features! When suggesting features:
- Explain the use case
- Describe the expected behavior
- Consider how it fits with existing features
- Be open to discussion and alternatives

## Code of Conduct

### Our Standards

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards others

### Unacceptable Behavior

- Harassment or discrimination
- Trolling or insulting comments
- Public or private harassment
- Publishing others' private information
- Other unprofessional conduct

## Questions?

Feel free to:
- Open an issue for questions
- Join discussions in existing issues
- Reach out to maintainers

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.

Thank you for contributing to Pane! 🎉
