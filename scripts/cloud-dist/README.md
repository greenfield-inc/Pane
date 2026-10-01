# cloud-dist

Builds and publishes the Runpane Cloud fork artifacts and the boat golden image. Nothing here publishes
upstream: releases go to the fork (`FORK_REPO`, default `jamari-morrison/Pane`) as **prereleases**, and
the scripts refuse a `greenfield-inc/*` repo.

| Script | Runs on | Does |
|---|---|---|
| `build-artifacts.sh [out]` | build host (boat devbox), repo root | frontend + main build, `electron-builder --linux deb --x64`, `npm pack` of `packages/runpane`, `SHA256SUMS.txt`, `build-info.json` |
| `publish-release.sh --devbox <id> --ref <branch>` | operator (agentbox) | runs the build on the devbox, downloads the files (in 45 MiB parts: boat `GET /artifacts` caps at 50 MiB), verifies sha256, `gh release create rc-<sha8> --prerelease`, checks anonymous download, updates `dist-current.md` |
| `record-release.sh rc-<sha8>` | operator | for a published prerelease: anonymous download check, CLI tarball sha256 check, updates `dist-current.md` (called by `publish-release.sh`; run it by hand for releases built by Actions) |
| `make-golden.sh --tag rc-<sha8>` | operator | sandbox → `golden/provision.sh` → bootstrap's `golden-scrub.sh` → `rp-golden-check golden` + `rp-golden-payload-check` → named snapshot `rp-loop-golden-<sha8>` → destroys the source → forks a gate sandbox from the snapshot → `golden/gate-fork.sh` → destroys the gate |
| `release.sh --devbox <id> --ref <branch>` | operator | both of the above, then, for `rc/integration` only, prunes older `rp-loop-golden-<sha8>` snapshots (keeps `KEEP_GOLDENS`, default 2) |
| `desktop-switcher-proof.mjs` | a Linux box on the tailnet, repo root, under `xvfb-run` | drives a packaged desktop (no mocks) against a live cloud Session: live `cloud sync` import, the host switcher, connect, a remote terminal, the asleep state; writes screenshots, a Playwright trace and `results.json` (settings in the file header) |
| `ports-row-proof.mjs` | a Linux box on the tailnet, repo root, under `xvfb-run` | drives a packaged desktop and the built web client (no mocks) against a live cloud Session's ports: the Ports chip row, opening a URL, a port opened from the CLI appearing live, close from the chip, a suggested listener published with one click; writes screenshots and `results.json` (settings in the file header) |

## Installing a fork build

`docs/RUNPANE_CLOUD.md` documents the upstream install path. To use a fork prerelease instead, take the
newest `rc-*` release whose notes say `branch rc/integration` (others are test builds of work branches); its
notes carry the exact install lines:

```bash
gh release list -R "$FORK_REPO" --limit 5      # newest first
gh release view rc-<sha> -R "$FORK_REPO"       # check "branch rc/integration", copy the npm line
npm i -g "https://github.com/$FORK_REPO/releases/download/rc-<sha>/runpane-<version>.tgz"
runpane version                                # <base>-rc.<date>.g<commit>
```

Point `runpane cloud setup --pane-deb-url` at the same release's `.deb`, and `--golden` at the
`rp-loop-golden-<sha8>` named after it (or the newest if that release has none; `release.sh` keeps two).

Desktop: the fix for outside edits to the saved hosts (`cd190659`, live reload, never written over) is in fork
builds from `rc/integration` at `080d3828` or later. The cloud prerelease ships the desktop as a Linux `.deb`
only, so an installed macOS or Windows desktop needs the quit-first workaround in `docs/RUNPANE_CLOUD.md`. A
fork `.deb` desktop shows a "Software Update" prompt for the upstream release on launch; dismiss it, since
updating would replace the fork build. To try the fix on Windows or macOS without touching an installed Pane,
use the side-by-side test build `rc-desktop-<sha8>` from `.github/workflows/rc-desktop.yml` (unsigned zips). It
keeps its data in `~/.pane_cloudtest`, runs next to the installed Pane, registers nothing machine-wide (no
login item, `pane://` handler, agent MCP servers or skills) and never offers updates. Remove it by deleting
its folder and `~/.pane_cloudtest`.

## GitHub Actions (no devbox)

`.github/workflows/rc-integration.yml` (fork only) runs the integrator suite on every push to `rc/integration`
and to every Phase 2 branch `rc/p2/**` (peers and the integrator candidate). On `rc/integration` it then runs
`build-artifacts.sh` on `ubuntu-24.04` (the boat sandbox OS) and publishes the prerelease `rc-<sha8>` with the
workflow's own token. A merge commit whose message contains `[no-release]` skips the publish (docs-only merges).
Afterwards, run `record-release.sh rc-<sha8>` on agentbox to update `dist-current.md`. This costs 0 boat starts.

## Integration vs branch builds

Only `--ref rc/integration` (`INTEGRATION_REF`) updates `~/rc-loop/results/dist-current.md` and produces
`rp-loop-golden-<sha8>`. Any other branch writes `~/rc-loop/results/dist-branch-<ref>.md` and names its golden
`rp-loop-golden-br-<sha8>`. That lets peers publish test builds without replacing the shared current
artifacts, and the pruning never touches their goldens. Clean up branch goldens by hand
(`DELETE /named-snapshots/<name>` with header `X-Ascii-Confirm-Delete: <name>`).

## Versions

Builds are labelled `<package.json version>-rc.<commit UTC YYYYMMDDHHMMSS>.g<sha8>` through
`electron-builder -c.extraMetadata.version`, so `package.json` is never edited and `pane --version` names the
commit. The timestamp makes versions sort by commit time under semver and dpkg, so installing a newer fork
`.deb` with apt is an upgrade. Fork versions sort below the upstream release with the same base version.

## Golden image

- The fork `.deb` only. It is not paired: no `~/.pane_remote`, no analytics id, no service unit.
- Tailscale installed, not joined.
- Playwright Chromium in `/opt/ms-playwright`, with `PLAYWRIGHT_BROWSERS_PATH` set in `/etc/environment`.
  Boat snapshots drop `~/.cache` and `/tmp`, and a directory `mv`'d in from those paths arrives empty.
- `rp-firstboot-identity` and `rp-golden-check` in `/usr/local/sbin`, and `/etc/rp-golden.json`.
  Forks are restored onto machines that are already running and don't reboot, so per-sandbox provisioning
  must run `sudo /usr/local/sbin/rp-firstboot-identity` itself before joining Tailscale.

The gate on the fork checks four things:

1. The identity strip list (fork mode).
2. `pane --version` equals the release version.
3. A headless daemon from `/opt/Pane/pane` answers `/health` on loopback.
4. Chromium takes a screenshot.

## Scrub and check: single source

The identity scrub and strip-list check are the files `runpane cloud` bootstrap runs on every new sandbox:
`packages/runpane/src/cloud/bootstrap/assets/golden-{scrub,check}.sh`. `make-golden.sh` reads them with
`git show $GOLDEN_ASSETS_REF:<path>` (default `HEAD`). Until the bootstrap branch is merged, pass
`GOLDEN_ASSETS_REF=origin/rc/w1/m1-bootstrap`. `golden/payload-check.sh` covers only what this image adds:
the Pane version, Tailscale, and Chromium.

## boat start budget

boat limits sandbox starts per account: 12 per minute, 60 per hour, 200 per day on plan box_20. Every create, fork and resume
by every peer counts. One `make-golden.sh` run costs **2 starts** (the source sandbox and the gate fork). A build costs
none, because it reuses the devbox. Both creates go through `sb-create-retry.sh`: it waits out `429 rate_limited`
(`START_WAIT_MAX_S`, default 1 h, polled every `START_WAIT_STEP_S`, default 120 s), so a limit hit between the
snapshot and the gate doesn't abort the run and waste the start already spent. Other create errors still fail at once. Before every start it also runs `$RC_BIN/starts-left.sh` if that exists: exit 3 (the hour window is used up) waits, and exit 4 (the day reserve is reached) refuses.

## Environment

`BOAT_HDR` (curl header file holding the boat `Authorization` header), `RC_BIN` (the rc-loop helpers
`devbox.sh`, `sb-create.sh`, `sb-destroy.sh`, `boat.sh`), `FORK_REPO`, `DIST_CURRENT`, `EVIDENCE_DIR`.
Defaults point at `~/rc-loop`. Create a devbox with `~/rc-loop/bin/devbox.sh create <name>`.
The devbox checks out `origin/<ref>`, so push the branch first.
