# Pane Release Instructions

Pane releases are cut from a clean `main` checkout with `scripts/release.js`.
The script updates `package.json`, commits `release: vX.Y.Z`, tags the same
commit, pushes `HEAD:main`, and pushes the tag.

The same release commit also keeps the npm and PyPI wrapper package versions in
sync through `scripts/sync-runpane-package-versions.js`.

## Mechanical Invariants

Before a release, these facts must be true:

- The worktree is clean.
- `HEAD` matches `origin/main`.
- For inferred bumps (`patch`, `minor`, `major`), `package.json` version matches
  the latest `v*` semver tag.
- `packages/runpane/package.json`, `packages/runpane-py/pyproject.toml`, and
  `packages/runpane-py/src/runpane/__init__.py` match the root release version.
- The release tag does not already exist locally or on `origin`.
- Dependencies are installed before running the release script so commit hooks can
  run successfully.

If `package.json` and the latest release tag disagree, do not run an inferred
patch. Decide the intended next version and run an explicit release instead:

```bash
pnpm run release 2.2.1
```

## Happy Path

```bash
git switch main
git pull --ff-only origin main
git status --porcelain
git tag --list 'v*' --sort=-v:refname | head -5
node -p "require('./package.json').version"

pnpm typecheck
pnpm lint
pnpm run check:runpane-package-versions
pnpm run test:runpane-contract
pnpm run test:runpane-package-smoke
pnpm test:ci:minimal

pnpm run release patch
```

If the release commit fails, the script aborts before creating or pushing a tag
as long as any changes remain in the worktree. Fix the hook, dependency, or
typecheck failure, restore the worktree, and rerun the release.

Use `minor`, `major`, or an explicit version when that is the intended release:

```bash
pnpm run release minor
pnpm run release major
pnpm run release 2.3.0
```

## GitHub Workflows

Pull requests to `main` run:

- `Code Quality`
  - typecheck
  - lint
  - runpane wrapper compatibility tests across Node, Python, Linux, macOS, and Windows
  - main process tests on Linux, macOS, and Windows
  - frontend unit tests
  - maintained Playwright smoke tests

Pushes to `main` run:

- `Code Quality`
- `Deploy Remote PWA Preview`

`v*` tag pushes run:

- `Build & Release`
  - macOS Apple Silicon and Intel installers
  - Linux installer artifacts
  - Windows x64 installer
  - Windows arm64 installer
  - GitHub release publishing
  - `SHA256SUMS.txt`
  - npm `runpane` publish
  - PyPI `runpane` publish
- `Notify website on release`

The release is not considered complete until the tag-triggered `Build & Release`
run succeeds and the GitHub release is published.

## Verification

After `pnpm run release ...` finishes:

```bash
git fetch origin main --tags
git rev-parse HEAD
git rev-parse origin/main
git tag --points-at HEAD
gh run list --limit 10
gh release view vX.Y.Z
```

Confirm:

- `HEAD` and `origin/main` point at the release commit.
- The release commit has the expected `vX.Y.Z` tag.
- `Build & Release` succeeded for the tag.
- `npm view runpane version` reports `X.Y.Z`.
- `python3 -m pip index versions runpane` includes `X.Y.Z`.
- `Notify website on release` succeeded for the tag.
- `Code Quality` succeeded for the release commit on `main`.
- `Deploy Remote PWA Preview` succeeded for the release commit on `main`.

## Required Secrets

GitHub Actions provides `GITHUB_TOKEN` automatically.

The npm and PyPI packages should publish through trusted publishing:

- npm: configure a trusted publisher for package `runpane` on npmjs.com with
  repository `greenfield-inc/Pane`, workflow filename `build.yml`, and `npm publish`
  permission. The workflow installs npm `11.5.1` or newer for OIDC support.
- PyPI: configure a trusted publisher for project `runpane` with repository
  `greenfield-inc/Pane`, workflow filename `build.yml`, and GitHub environment `pypi`.

Fallback token publishing is allowed only for first package reservation or
manual recovery. Use `NPM_TOKEN` or `PYPI_API_TOKEN` as local environment
variables or GitHub Actions secrets, do not commit token files such as `.npmrc`
or `.pypirc`, and revoke or rotate the tokens after use.

If the source repository remains private, do not promise npm provenance:
npm trusted publishing can still be used, but npm provenance attestations are
not generated for private repositories.

The release and preview workflows also depend on repository secrets and
variables configured in GitHub Actions. Relevant examples include:

- `SITE_REPO_DISPATCH_TOKEN` for website release notification.
- Google Cloud workload identity, service account, project, and region values
  for the remote PWA preview deploy.
- Platform signing or publishing credentials if signing is re-enabled.

## Auto-Update Files

The build process generates update metadata and installers under
`dist-electron/` in the release workflow:

- `latest-mac.yml`
- `latest-linux.yml`
- `latest-linux-arm64.yml`
- `latest.yml`
- macOS `.dmg` and `.zip`
- Linux `.deb` and `.AppImage`
- Windows `.exe`
- npm package `runpane`
- PyPI package `runpane`

## Rollback

Do not retag an existing version. If a release has a critical issue:

1. Fix the issue on `main`.
2. Cut a new patch version.
3. Leave the broken tag/release history intact unless maintainers explicitly
   decide to remove it.

Users can always manually download the latest good release from GitHub Releases.
