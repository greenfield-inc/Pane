# Update prerequisites, status and recovery

`runpane update` defaults to the running Pane app and the CLI that received the
command, on the machine where the command runs. A remote host selected in the UI
does not change that target. Use `--pane-only` or `--cli-only` for one component.
Run `runpane update --dry-run --json` first to see the executable, data directory,
CLI owner and supervisor capability without starting an update.

## Prerequisites

Both the running app and the requested app release must support continuity
protocol 1. No existing 2.4.182 release has the required `continuity.json`
manifest. To bootstrap this feature, install a continuity-capable release with
its normal installer before using this path; installing the CLI alone does not
add support to an older running app. A requested older target without that manifest is refused before shutdown.

Use an account that owns the app and CLI directories, in an interactive login
with launchd (macOS), Task Scheduler (Windows), or user systemd (Linux). The app
must be a packaged macOS bundle, Windows installation, or owned Linux AppImage.
System package installations on Linux require their package manager. App updates
require platform signature verification on macOS and Windows. The official
Windows 2.4.182 installer is unsigned and is refused by this verifier.

Install standalone Node 22 or newer and make it available on PATH to the process
starting the update. The helper copies this runtime before shutdown; Electron
inside the app being replaced is insufficient. npm must also be available when
updating a JavaScript CLI. The supported CLI owners are:

- Pane's managed CLI, normally under `<pane-dir>/bin`; an explicit CLI-only
  update remains selected when an older Pane next starts.
- A writable global npm `runpane` installation in the prefix reported by its
  own npm. Local project packages and npx cache copies are refused.
- The invoking Python environment's writable `runpane` package, with its own
  `python -m pip` available. Virtual environments, including pipx environments,
  and user-site installs are identified by their actual package paths. A pip
  dry run must accept the staged wheel. The Python wrapper also requires the
  continuity engine installed by Pane under the same `--pane-dir`; pip alone
  does not install that engine or Node.

The helper checks directory permissions, data/profile readability and free
space on each affected volume. Windows can exclusively lock live browser-profile
files; their sizes are counted before shutdown, and the snapshot must successfully
read them after clean shutdown before installation is allowed. It stages downloads
before shutting down Pane.
A successful dry run checks local prerequisites; it does not download or prove
that the requested release passes artifact verification.

## Status and exit codes

Keep the operation's `id` and use the same `--pane-dir`:

```sh
runpane update --json
runpane update --status <id> --pane-dir <path> --wait --json
```

The status command reads the local journal even while Pane is stopped, provided
the invoking CLI and its runtime can still launch. If the normal command fails
because the app or CLI was damaged, read `<pane-dir>/updates/<id>/status.json`
directly in a text editor. On macOS/Linux, use
`cat "<pane-dir>/updates/<id>/status.json"`; in PowerShell, use
`Get-Content -Raw '<pane-dir>\updates\<id>\status.json'`. Replace the placeholders
with the original data directory and operation ID. This read does not start or
resume an update. If the ID was lost, inspect the directories under `updates`
and match the journal's ID and host with `preflight.json`; do not guess ownership
from timestamps alone. A missing or unreadable journal requires maintainer help.

The command's JSON
object has these fields; this result is documented here and is not currently a
named schema in the agent contract's `jsonSchemas` collection.

| Field | Meaning |
| --- | --- |
| `id`, `host`, `scope`, `version` | Operation identity, local machine, `both`/`pane`/`cli`, and requested or resolved release |
| `phase` | Current stage or terminal outcome |
| `completed` | Stages durably recorded as finished |
| `appUpdated`, `cliUpdated` | Selected component installation finished; neither implies host or panel readiness |
| `hostReachable` | Relaunched host passed version, identity and endpoint/auth checks; false for CLI-only updates |
| `restored` | Per-panel `{panelId, outcome, reason}` records; `resumed`, `preserved`, or `needs-attention` |
| `error` | Failure explanation, when present |
| `updatedAt`, `helperPid` | Last recorded time and acknowledged helper PID; PID presence alone does not prove liveness |
| `statusFile`, `next` | Journal location and command to inspect it again |

Stages are `accepted`, `stage`, `checkpoint`, `stop`, `snapshot`, `install`,
`launch`, `health`, and `restore`. Terminal phases are `complete`, `failed`, and
`needs-attention`. `complete` means all selected components and applicable health
and restoration gates finished; preserved idle/blocked panels are intentional.
`needs-attention` can mean a partially updated installation or individual panels
requiring manual action. Inspect the booleans, completed stages, error and every
panel outcome together.

Exit 0 means the returned status is not a terminal failure. Without `--wait`, it
can still be in progress. `failed` and `needs-attention` return exit 1. Command or
preflight errors also return nonzero. `--wait` has no overall timeout. Ctrl+C stops
the waiting caller, not the independent operation; inspect status before retrying.
There is no supported operation cancellation command. A fresh update runs
preflight before checking locks. If preflight succeeds and an existing lock is
found, it returns that operation's status instead of starting another install.
During downtime, preflight may fail before reaching the lock. Use `--status`
(which bypasses preflight), or read the journal directly, to inspect recovery.

## What happens to agent work and drafts

Only a panel recorded as actively working, with an exact conversation ID and a
supported resume command, is eligible to reopen. Built-in launch resolution
covers Claude, Codex, Cursor and native OpenCode. OpenCode requires a recorded
valid `ses_…` selector and an eligible direct launch command; incompatible Session
wrappers or custom-resume settings are refused. Custom commands use their
effective resume profile: an explicit template containing `{sessionId}`, or the
derived profile for a recognized Agent Farm launch. Eligibility and command
construction do not prove history exists or guarantee provider restoration:
`resumed` requires fresh conversation-identity and readiness evidence from the
running harness. An incompatible command or missing evidence yields
`needs-attention`.

Readiness requires an explicit adapter acknowledgment after the harness has
accepted the exact conversation and is usable. The relaunched process receives
a fresh `PANE_UPDATE_RESUME_NONCE`. An adapter may emit one complete line
`PANE_UPDATE_RESUME_READY=<nonce>:<actual-loaded-conversation-id>` only after that
acceptance. The nonce binds the acknowledgment to this launch; an old marker,
wrapper ID line, generic output, startup animation or CLI-ready timeout does not
confirm readiness. Login/trust blockers and command exit prevent success.
Do not print this marker merely because a wrapper started or received a resume ID.

The built-in Claude/Codex/Cursor/OpenCode launch commands do not currently provide
this acknowledgment themselves; Pane has no vendor acknowledgment adapter for
them. Without an instrumented harness adapter and verification of the fresh
challenge plus actual loaded conversation ID, reopening these conversations
reports `needs-attention`; inspect the live panel manually. Custom
reported/generated commands, including Agent Farm, can integrate the same
acknowledgment. A reported conversation ID alone is insufficient. The native QA
adapter proves this protocol with a harmless process, not a vendor login or
conversation acceptance.

Reopening the conversation does not submit the interrupted task again. The agent
may return to its prompt; review it and decide what to send. Idle, completed and
approval-blocked work stays stopped. The updater sends no `continue`, prompt,
queued mutation, or draft input.

Before shutdown, the checkpoint saves each panel's prior state, activity, launch
profile, conversation ID and launch/worktree/Session cwd. Unsubmitted composer
text detected in the terminal prevents automatic reopening. Inspect that panel's
`priorState.screenText`, `initialInput` and `initialInputFile` in `checkpoint.json`
for the saved evidence. Screen text can contain other terminal content and is not
a promise of a complete editable draft. Recover and verify the intended text
manually before submitting anything. Do not share checkpoint files publicly.

## Recovering an interrupted operation

All paths below use the same Pane data directory supplied with `--pane-dir`.
The operation directory is `<pane-dir>/updates/<id>/`:

| File or directory | Purpose |
| --- | --- |
| `status.json`, `preflight.json`, `staged.json` | Progress, original executable/data/profile and CLI paths, staged package/backup paths |
| `checkpoint.json`, `restoration.json` | Prior panel state and durable per-panel launch claims/outcomes |
| `quiesced.json` | Original host's clean-shutdown acknowledgment |
| `snapshot/data`, `snapshot/profile`, `snapshot/complete.json` | Pre-install copy; only the complete marker establishes a finished snapshot |

### Inspecting the supervisor and remaining processes

Use the operation ID from the journal. These commands inspect state; they do
not stop jobs or clear locks:

| Platform | Supervisor and logs |
| --- | --- |
| macOS | `launchctl print "gui/$(id -u)/com.pane.update.<id>"`; read `<operation-directory>/supervisor.log` and `supervisor.plist` for the executable and arguments. |
| Windows | `schtasks /Query /TN "com.pane.update.<id>" /V /FO LIST`; inspect `<operation-directory>/supervisor.xml`. Task Scheduler's History tab or the `Microsoft-Windows-TaskScheduler/Operational` event log may provide execution history if enabled. This adapter does not create a stdout/stderr log file. |
| Linux | `systemctl --user status "com.pane.update.<id>.service"` and `journalctl --user -u "com.pane.update.<id>.service"`; transient units may already have been collected. |

Windows relaunch can also create `com.pane.update.<id>-app`; inspect that task
when present. A completed or missing supervisor is not proof that a child
installer has exited. On macOS/Linux use `ps -axo pid,ppid,command`; on Windows
use `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine`
in PowerShell. Compare full paths and arguments with this operation's staged
runtime/helper, `staged.json` installer path and `preflight.json` installation.
Check helper children and installer processes separately; a reused PID, generic
process name or stale Task Scheduler result is insufficient. If processes cannot
be attributed confidently, access is denied, or logs contradict the journal,
leave locks and snapshots intact and ask a maintainer to inspect them.

### Recovery steps

1. Read status before starting another installer. If it is progressing, let it
   finish. If it stops progressing, inspect the helper supervisor and logs. A
   missing caller or terminal is expected; a PID alone is insufficient to decide
   the helper is dead. Do not remove locks while any helper/installer is active.
2. For `failed` before shutdown, Pane remains available and the terminal operation
   releases its locks. Correct the reported preflight/staging problem and retry.
3. For `needs-attention` with `hostReachable: true`, open the same installed Pane
   and inspect each panel outcome. Do not replay input whose delivery is unknown.
   Use the panel's normal explicit resume/restart control after reviewing its saved
   conversation and draft evidence. Already resumed panels must not be restarted
   merely because another panel needs attention.
4. If Pane is stopped, use `preflight.json` to identify the exact executable,
   `paneDir` and `userData`. After establishing that no update helper/installer is
   still acting, launch that installation with `PANE_DIR` set to `paneDir` and
   `--user-data-dir=<userData>`. If the executable is missing or damaged, repair
   that same installation with the same or newer compatible official installer.
   Keep the operation directory and snapshot while diagnosing the failure.
5. Never replace a migrated database with the old snapshot while the newer app is
   running. A rollback needs a compatible application and a complete data/profile
   snapshot restored together while all relevant processes are stopped. This
   updater does not automate or validate such a rollback. Get maintainer help
   when compatibility or installer state is uncertain.

A post-shutdown `needs-attention` operation deliberately keeps its locks. There
is no automated recovery/lock-clear command. After recovery is verified and all
operation-owned helpers/installers have exited, the installation owner or a
maintainer can archive the operation and move aside only locks whose `owner.json`
contains this exact operation ID. Lock directories are listed in
`preflight.json` as `lockDirectory` and `additionalLockDirectories`. Preserve the
journal/checkpoint/snapshot; do not delete another operation's locks or infer
ownership from a reused PID. Incomplete or ambiguous locks require the same
manual inspection. If recovery of a crashed lock cleanup is itself interrupted,
its persistent cleanup claim also requires manual inspection; another caller
will not steal it or report a new update as completed. Logout/reboot continuation
is not guaranteed.
