# Runpane Cloud live gates

Executable versions of the milestone gates in the Runpane Cloud plan (M0–M4). They run from a
workstation against **real boat.dev sandboxes** on the Tailscale tailnet, and write a pass/fail record
with evidence for every check. They are not part of `pnpm test`: they cost money, need provider
credentials, and take minutes.

## What the gates may use

- The **documented product surface**: the `runpane` CLI (`runpane cloud …`, `runpane panels …`,
  `runpane peers …`, `runpane --host …`), the daemon's `GET /health`, `POST /invoke`, `GET /events`,
  and the coordinator's `/cloud/status` and `/cloud/wake`.
- An **independent oracle** (`lib/cloudlab.py`, Python standard library only) that asks the boat and
  Tailscale APIs what really happened: does the sandbox exist, what state is it in, which tailnet
  device has which tags. The oracle never decides a gate by itself; it checks the product's claims.

Gates never read daemon internals (SQLite, config files) except where a check is about files on disk
(for example, the strip-list check).

## Layout

| Path | What it is |
|---|---|
| `lib/cloudlab.py` | Oracle + recorder: boat REST, Tailscale API, pairing decode, `/health`, `/invoke`, result records, matrix renderer |
| `lib/common.sh` | Run directory, `rec`, resource registry, teardown trap (tailnet device first, then sandbox), secret redaction |
| `lib/provision.sh` | Manual cloud-Session fixture (provider + Tailscale + published daemon installer), for M0 and for build-pinned M2/M3 runs |
| `lib/cli.sh` | Resolves the `runpane` CLI under test and isolates its cloud config per run |
| `lib/fixtures.sh` | In-sandbox Pane fixtures through the `runpane` CLI |
| `gates/integration.sh` | **Combined M1 + M2-resume + M3 on shared sandboxes (~5 boat starts)**: the batched gate for integration heads |
| `gates/m0-harness.sh` | M0 facts + harness proof |
| `gates/m1-cli.sh` | M1: `runpane cloud setup/new/status/stop/wake/destroy` |
| `gates/m1-golden.sh` | M1: a fork of the golden image has none of the strip-list files |
| `gates/m2-resume.sh` | M2: `panels submit` to the same panel after a daemon restart and after a boat power-off |
| `gates/m2-safestop.sh` | M2: safe-to-stop refuses in each of the 6 conditions; flush survives a power-off; `/health` version + readiness |
| `gates/m3-peers.sh` | M3: peer submit lands framed in the orchestrator panel; shell/events/WS/non-allowlisted → 403; idempotency |
| `gates/m4-coordinator.sh` | M4: reconciler never destroys; idle-stop through the `serve` loop respects safe-to-stop; `/cloud/status` never wakes; `/cloud/wake`; runaway guard |
| `gates/p3-broker.sh` | **P3 broker (phase3-design §9 P2+P3, 2 starts)**: fresh coordinator + Session; broker pointed at a fake GitHub on the coordinator's loopback; a real Claude agent pushes, opens a draft PR and an issue with no client attached; live refusals (master, namespace, workflow file, merge, another Session's PR/issue, repo allowlist, token from another node); fake log + audit + socket samples + ACL as evidence |
| `lib/fakegithub.py` | Fake GitHub (stdlib): real `git http-backend`, App JWT (RS256) + downscoped installation tokens, per-endpoint permissions, GitHub's workflow-push rule, no branch protection; JSONL request log; admin seeding. `lib/fakegithub-selftest.sh` proves it (runs in fork CI) |
| `lib/broker.sh` | Broker gate helpers: deploy the fake on a sandbox, raw in-Session broker calls with the Session's own token, and the `runpane` spellings owned by the broker/agent CLI (one place) |
| `p4-montlake.sh` | **P4, one command**: `p4-montlake.sh <App .pem or fine-grained PAT file> <host>` against real montlakev2: draft PR + issue from `cloud/<host>/p3-proof`, refusals, then cleanup and fresh final checks. It touches ONLY what it created (recorded with sha/number) or what you adopt explicitly (`--adopt-issue N`, `--adopt-pr N`, `--adopt-branch NAME@SHA`); pre-existing refs are recorded and left alone, a new ref that isn't ours is a FAIL (never deleted), `--keep-branch` deletes nothing, every failed GitHub call is a FAIL. Keeps the Session awake (a user `/invoke` every 60 s). `--dry-run` prints exactly what cleanup would touch. `lib/p4-selftest.sh` proves the safety logic against the fake (runs in fork CI) |
| `run-gates.sh` | Runs a list of gates from a snapshot copy (edits never corrupt a running run) and refreshes the matrix |
| `sweep.sh` | Deletes stray `rp-loop-e2e-*` sandboxes and tailnet devices after an aborted run |
| `morning-smoke.sh` | One command for a user to prove their own setup end to end |

## Running

```bash
tests/cloud-e2e/gates/m0-harness.sh                       # harness proof on runpane@latest
E2E_DAEMON_DEB_URL=<fork .deb> tests/cloud-e2e/gates/m2-resume.sh
tests/cloud-e2e/run-gates.sh integration m2-safestop m4-coordinator morning-smoke   # the full batched matrix
KEEP=1 tests/cloud-e2e/gates/m1-cli.sh                    # leave the sandbox up for inspection
```

Evidence goes to `$E2E_EVIDENCE_ROOT/<run-id>/` (default `~/rc-loop/evidence/e2e-gates`), and the
matrix to `$E2E_MATRIX` (default `~/rc-loop/results/e2e-matrix.md`). Each check is one JSON line in
`results.jsonl`: `PASS`, `FAIL`, `XFAIL` (a known gap on this target, such as upstream before M2),
`BLOCKED` (the feature isn't in the build under test), `SKIP`, or `INFO`.

## Credentials

Read from files only, never printed, never put on a command line or in sandbox metadata:

| Variable | Default | Content |
|---|---|---|
| `CLOUDLAB_BOAT_AUTH_HEADER_FILE` | `~/rc-loop/secrets/boat.hdr` | `Authorization: Bearer boat_…` |
| `CLOUDLAB_BOAT_API_KEY_FILE` | — | the bare boat key (alternative) |
| `CLOUDLAB_TS_CLIENT_ID`, `CLOUDLAB_TS_SECRET_FILE` | loop client, `~/rc-loop/secrets/TAILSCALE_OAUTH_SECRET` | Tailscale OAuth client (`devices`, `auth_keys` for `tag:rp-session`) |

Tailscale auth keys are single-use, pre-authorized, tagged `tag:rp-session`, and go into the sandbox
through a 0600 file that is shredded after `tailscale up`. Tailscale SSH is never enabled.
Pairing codes are fetched into a 0600 file inside the run's `.secrets/` directory, which is deleted at
the end of the run; evidence files are scanned and redacted before the run exits.

## Cleanup

Every sandbox a run creates is named `rp-loop-e2e-*` and listed in the run's `resources.txt`.
On exit the run deletes the tailnet devices first (M0: `tailscale logout` does not remove tagged
devices), then the sandboxes. `KEEP=1` skips teardown and prints what was left.

## Boat start budget

boat limits sandbox starts (create, fork, resume) per account: 12/min, 60/hour, 200/day. Every gate reads
`GET /limits` before it starts anything: it waits when the hour is used up and records BLOCKED (starting nothing)
when the day's remaining starts would drop below the reserve (`E2E_DAY_RESERVE`, default 25). The full matrix
(`integration`, `m2-safestop`, `m4-coordinator` with `E2E_M4_SKIP_RECONCILE=1`, `morning-smoke`, `m1-golden`) costs 12 starts.
