# Pane runbook

How Pane ships and what runs outside a developer's machine. Pane has no server
and no production database: the desktop app keeps its data on each user's
machine. The things that ship are installers, two CLI packages, and a preview
build of the Remote PWA.

## Surfaces

| Surface | Workflow | Trigger | What it does |
| --- | --- | --- | --- |
| Stable release | `Build & Release` (`.github/workflows/build.yml`) | `v*` tag push | Builds macOS, Linux and Windows installers, publishes the GitHub release, uploads `SHA256SUMS.txt`, publishes `runpane` to npm and PyPI, and notifies the website repo |
| Release build check | `Build & Release` | push to the `release` branch | Builds the same installers as artifacts; publishes nothing |
| Release recovery | `Build & Release` | manual, with `release_tag` and `publish` | Rebuilds and republishes an existing tag |
| Nightly / canary | `Nightly / Canary Release` (`nightly-release.yml`) | manual, with `channel` and `source_ref` | Publishes a GitHub prerelease that is not marked Latest and has no update metadata, so auto-update never moves stable users onto it |
| Remote PWA preview | `Deploy Remote PWA Preview` (`deploy-remote-pwa-preview.yml`) | push to `main` or `nightly` | Builds `frontend`, pushes an image to Google Artifact Registry, and deploys it to Cloud Run |
| Website notification | `Notify website on release` (`notify-website.yml`) | manual only | Re-sends the release event to the website repo; tag releases already do this from `Build & Release` |
| PR checks | `Code Quality` (`quality.yml`) | pull requests and pushes to `main` | Typecheck, lint, markdown link check, unit tests on Linux, macOS and Windows, the runpane wrapper matrix, and the Playwright smoke suite |
| React review | `React Doctor` (`react-doctor.yml`) | pull requests that touch `frontend/` | Comments on new React findings; advisory, never blocks |
| Traffic snapshot | `GitHub traffic → PostHog` (`traffic-snapshot.yml`) | daily 06:00 UTC | Copies GitHub traffic and release download counts into PostHog |

## Stable release

Releases are cut with `scripts/release.js`. It refuses to run unless:

- the worktree is clean;
- `HEAD` matches `origin/main`;
- for `patch`, `minor` and `major`, `package.json` matches the latest `v*` tag;
- the version in `packages/runpane/package.json`,
  `packages/runpane-py/pyproject.toml` and
  `packages/runpane-py/src/runpane/__init__.py` matches the root version;
- the tag doesn't already exist locally or on `origin`.

Release from a detached copy of `origin/main`, so no local work can slip into
the release commit:

```bash
git fetch origin main --tags
git checkout --detach origin/main
pnpm install

pnpm typecheck
pnpm lint
pnpm run check:runpane-package-versions
pnpm run test:runpane-contract
pnpm run test:runpane-package-smoke
pnpm test:ci:minimal

pnpm run release patch      # or minor, major, or an explicit version such as 2.5.0
```

Two PRs that each pass CI can still break `main` together, so run the typecheck
on the merged `main`, as above, rather than trusting the PR runs.

The script syncs the package versions, commits `release: vX.Y.Z`, tags it, pushes
`HEAD:main` and then pushes the tag. If `package.json` and the latest tag
disagree, it refuses an inferred bump; pass an explicit version instead. If the
release commit fails, nothing is tagged or pushed: fix the cause, restore the
worktree and run it again.

### What the tag runs

```
build (macOS + Linux) ─┐
                       ├─ publish-windows ─ publish-release ─ checksums ─┬─ notify-website
build-windows (x64,  ──┘                                                ├─ publish-npm   ┐
  arm64)                                   validate-runpane-packages ───┴─ publish-pypi  ┘
```

`publish-npm` and `publish-pypi` each need both `checksums` and
`validate-runpane-packages`.

### Verify

```bash
git fetch origin main --tags
git tag --points-at origin/main
gh run list --limit 10
gh release view vX.Y.Z
npm view runpane version
python3 -m pip index versions runpane
```

The release is done when `Build & Release` succeeds for the tag and the GitHub
release is published. Also check that `Code Quality` and `Deploy Remote PWA
Preview` passed on the release commit.

Auto-update reads `latest-mac.yml`, `latest-linux.yml`,
`latest-linux-arm64.yml` and `latest.yml` from the release, so a published
release reaches existing installs without any further step.

## Recovery and rollback

- **Never retag a version.** To undo a bad release, fix `main` and cut a new
  patch. Auto-update moves users to the newest release. Leave the broken
  tag and release in place unless the maintainers decide to remove them.
- **A publish job failed:** run `Build & Release` manually with
  `release_tag=vX.Y.Z` and `publish=true`.
- **The website wasn't notified:** run `Notify website on release` manually.
- **Bad Remote PWA preview:** push a fix to `main`. Shifting Cloud Run traffic
  back to an earlier revision
  (`gcloud run services update-traffic <service> --to-revisions <revision>=100`)
  should also work, but it is unverified: nobody has done it for this service yet.

## Nightly and canary builds

Run `Nightly / Canary Release` from the Actions tab. Choose `nightly` or
`canary` and a branch, tag or SHA. The result is a GitHub prerelease for
manual testing; stable users never receive it.

## Remote PWA preview

Every push to `main` or `nightly` deploys the Remote PWA to a Cloud Run
service. The GCP project, region, registry, service name and deploy identity
come from repository variables: `GCP_PROJECT_ID`, `GCP_REGION`,
`GAR_REPOSITORY`, `CLOUD_RUN_SERVICE`, `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`,
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`. The one-time
GCP setup is `scripts/gcp/setup-remote-pwa-preview.sh`.

## Secrets and variables

Names only; values live in the GitHub repository settings.

| Name | Used by | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | all | Provided by Actions |
| `NPM_TOKEN`, `PYPI_API_TOKEN` | `build.yml` | Fallback only. npm and PyPI publish through trusted publishing (repository `greenfield-inc/Pane`, workflow `build.yml`, PyPI environment `pypi`). Use a token only for manual recovery, never commit `.npmrc` or `.pypirc`, and revoke the token afterwards |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | `build.yml` | macOS signing. It turns on only when all five are set; otherwise builds are unsigned |
| `SITE_REPO_DISPATCH_TOKEN` | `build.yml`, `notify-website.yml` | Sends the `pane-release` event to the website repo |
| `TRAFFIC_TOKEN` | `traffic-snapshot.yml` | Reads repository traffic |
| `GCP_*`, `CLOUD_RUN_*` variables | `deploy-remote-pwa-preview.yml` | See [Remote PWA preview](#remote-pwa-preview) |

Local development needs no secrets and no `.env` file.

## Migrations

Pane's SQLite schema is `main/src/database/schema.sql`. Later changes are
inline migrations in `main/src/database/database.ts`. They run when the app
starts, on each user's machine, against `<PANE_DIR>/sessions.db`. There is no
server database.

- Never run a migration against your real `~/.pane/sessions.db`. It applies on
  the next restart of the installed app after the release ships.
- To prove a migration on real data, copy the database with SQLite's online
  backup. The database runs in WAL mode (`database.ts`), so a plain file copy
  can miss recent writes that are still in the `-wal` file. Then run
  `pnpm --filter main build` and a script that requires
  `main/dist/main/src/database/database.js` against the copy and calls
  `initialize()`. Put the before and after numbers in the PR.
- Vitest already points `PANE_DIR` at a temporary directory
  (`main/src/test/setup.ts`). Any ad-hoc script that imports the database
  service must set `PANE_DIR` itself.
