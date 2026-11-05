# Cross-OS QA through Pane Workspaces

For OS-sensitive changes or cross-platform claims, discover reachable machines,
run isolated checks, and collect proof per OS. OS-sensitive work includes paths,
shells, native modules, installers, desktop UI, terminals, file watching, line
endings, WSL interop, and simulators. Keep the caller's authorization, delegation,
time, and publication limits; preserve the PR's current draft/ready state.

## Detect and plan

In a Pane Session, find and read its original `runtime-context.md` through the supplied
brief or Session AGENTS instructions. Use its bundled bridge (`PANE_RUNPANE_BIN`
or the named path), with the required `--pane-dir` on every call. WSL needs that
Windows bridge to reach Pane's named pipe; global Linux runpane targets Linux
sockets. The bridge handles Windows TEMP, PowerShell, and path translation.

Run `runpane doctor --json`. For a Windows-host bridge, confirm `wrapper.paneDir`
matches the Session, `platform.os` is `win32`, and `daemon.reachable` is true.
Missing context, bridge, or matching daemon is BLOCKED; continue independent
local checks. All local `runpane` examples below mean this verified invocation,
including its required flags. Remote commands use the remote machine's own
runpane and data directory.

Run `runpane workspace list --json` and `runpane agent-context --json`. When
`workspaces.state` is `on`, match online `otherMachines` with the list's OS and
`info.wslDistros`, `info.isWsl` / `isWsl` details. Confirm shell/app readiness;
online status and listed distros identify candidates, not completed checks.

Plan the relevant checks once per reachable OS, including the local OS. Use
one machine per OS unless architecture/runtime differences matter. Include all
claimed platforms: offline machines, disabled Workspaces, or unavailable tools
get BLOCKED rows with reasons. Leave infrastructure changes to their owner.
Name WSL distros separately from native Windows. For OS-neutral work, state why
local checks suffice. Continue independent platforms when another is blocked.

## Run and observe

Read installed syntax with `runpane agent-context --command "<command>" --json`
and discover each machine's saved repo with `runpane repos list --json`. Use
its paths and shell quoting. On this machine, QA runs as a new agent tab in the
feature's existing Pane (`runpane panels create --pane <id>`), never a new Pane.
Another machine has no worktree for the feature, so it gets one QA Pane per
feature: create it once and reuse it for every later QA run there. Prefer a
visible QA agent when delegation is allowed (a tab here, the machine's QA Pane
elsewhere);
leaf helpers use direct exec and return agent requests (OS, SHA, check plan) to
the parent. The parent owns authorized launches and evidence collection, or
reports the platform BLOCKED.

`panes create` owns the new worktree, so use it only when that machine has no Pane
for this feature yet; pass a saved base repo as `--repo`. A QA Pane on another
machine fetches and checks out the target SHA there and isolates the app before
testing. A QA tab in the feature's Pane on this machine shares the feature's
checkout: it tests the branch as checked out, confirms `git rev-parse HEAD`
equals the target SHA, and never runs `git checkout`, `reset` or `stash`. Replace all placeholders in these templates:

```sh
# This machine: a tab in the feature's Pane.
runpane panels create --pane <feature-pane-id> --agent <agent> --initial-input "<SHA, checks, evidence, isolation>" --source agent --no-focus --wait-ready --yes --json
# Another machine, first QA run for this feature only:
runpane workspace <machine> exec -- 'runpane panes create --repo <remote-repo> --name <qa-name> --agent <agent> --prompt "<SHA, checks, evidence, isolation>" --source agent --no-focus --wait-ready --yes --json'
# Later QA runs on that machine: a tab in its existing QA Pane.
runpane workspace <machine> exec -- 'runpane panels create --pane <remote-qa-pane-id> --agent <agent> --initial-input "<SHA, checks, evidence, isolation>" --source agent --no-focus --wait-ready --yes --json'
# Direct checks also suit helpers that cannot delegate.
runpane workspace <machine> exec -- '<command>'
```

For another machine with no QA Pane for this feature, `runpane handoff "<agent>
on <machine>" --note-file <note>` is an alternative to the first-run template:
inspect it with `--dry-run` first, and carry the same SHA, checks, isolation, and
evidence requirements in the note. Handoff creates a Pane, so never hand off to
this machine; QA here is a tab.

Read Pane/panel IDs from the result or `panels list --pane <id>`. Route remote
`panels screen`, `input`, `submit`, and `last-message` through that machine's
workspace exec. Inspect after launch/submission, wait for completion, read the
final message, and retrieve logs/media. Discover command schemas as needed.

For WSL, select a distro from `wsl.exe --list --quiet`, then execute explicitly:
`wsl.exe -d <distro> -- bash -lc '<check>'`, quoted for the outer shell too.
Inside the distro, establish the Linux repo path and capture `uname -s`, distro
identity, and `git rev-parse HEAD` with the output. A failed start is BLOCKED.

On another machine, fetch and check out the requested SHA in its QA Pane,
including direct-exec checks. On this machine, check out nothing. Verify
`git rev-parse HEAD` before tests everywhere. For a
composite merge commit, record its SHA and prove the requested head is included
with `git merge-base --is-ancestor <requested-head> HEAD`. Retain `git status
--short` and the patch for dirty trees; label that evidence as dirty-state proof.
Preserve the person's checkout and running Pane instance. Use separate
dependencies/build output, ports, app user-data, and Pane app-build `PANE_DIR`.
Scope `PANE_DIR` to the test app while the orchestration CLI stays connected
to its existing daemon. Clean up only resources this run created.

## Collect per-OS proof

Repeat the same planned check rows per OS/runtime. Mark OS-specific rows
Skipped (not applicable) elsewhere. For executed checks, capture actual
commands, stdout/stderr, exit codes, machine/runtime, exact SHAs, and evidence
paths. Pair baseline failing/old behavior with candidate behavior under the
same check: screenshots/recordings for UI, command output for CLI. If the
baseline cannot run, mark before/after proof BLOCKED with the reason; report
any candidate-only pass separately.

Keep evidence in the caller's temporary folder, separated by OS. Name the
machine for remote paths and retrieve artifacts for review when possible.

| OS / runtime | Baseline → tested SHA | Check / command | Result | Before → after evidence; exit codes / reason |
| --- | --- | --- | --- | --- |
| <OS, WSL distro> | <base> → <head> | <check; actual command> | PASS / FAIL / BLOCKED | <paired proof or blocker> |

Give every planned platform a verdict for its applicable checks:

- `✓ PASS on <OS>`: all planned checks passed with evidence.
- `✗ FAIL on <OS>: <failure>`: an exercised check failed.
- `BLOCKED on <OS>: <reason>; unverified`: proof is missing or incomplete;
  list any completed checks separately.

A native OS pass requires the relevant real path executing on that OS with
command/output and tested SHA. Label mocks, fake transports, OS overrides,
portable unit tests, connectivity, and agent launches by what they prove.
WSL evidence proves its named Linux runtime; Windows requires native execution.

## Practical lessons

- **Bridge flags:** some WSL→Windows bridges append `--pane-dir` after the
  remote command. In shells supporting `#` comments, end that command with
  ` #` to absorb the flag. ` ; echo #` can mask the check's status; preserve
  its original exit code. Check the returned shell/status; cmd.exe lacks
  `#` comments. Outside a configured Session, discover Windows runpane and
  invoke it via PowerShell from a Windows directory.
- **Borrow tools:** use a machine's existing `gh` authentication with
  `runpane workspace <mac> exec -- 'cd <repo> && gh …'`. Set GitHub targets
  explicitly and keep credentials on their host; caller publication rules apply.
- **Delivery:** Codex queues `panels submit` until its turn ends; `delivery.state:
  queued` confirms queued input, not that it was read. For urgent corrections
  to your QA agent, send `panels input --panel <id> --keys escape`, submit the
  correction, and inspect `panels screen`. Leave unrelated agents running.
- **First run:** inspect `panels screen` for Claude/Codex folder-trust dialogs
  or Codex's “Cannot use the background server → Run without daemon this time”.
  Answer for the intended checkout with `panels input --keys …` under the
  caller's authorization. Treat `verifiedSubmitted:false` or
  `composer.hasUndeliveredText:true` as unconfirmed delivery; inspect and submit
  as needed before counting the task running.
- **Electron capture:** macOS background capture needs Screen Recording
  permission; Windows gdigrab can give black frames. CDP capture of the isolated
  app (`--remote-debugging-port`, `Page.startScreencast`) works without OS capture
  permission on macOS, Windows, and WSL. Bind debugging locally, collect and
  acknowledge frames, and inspect media. CDP covers web contents; verify native
  dialogs/OS chrome separately when relevant.
- **Windows fixtures:** use hermetic fake daemons/transports for portable tests;
  extensionless shebang fake CLIs fail natively. Test real native execution when
  that boundary matters, and label fixture results separately.
- **Disk pressure:** pnpm node_modules may share hard links with its store, so
  deleting them reclaims little. `pnpm store prune` frees unused store content;
  treat it as shared-machine maintenance requiring coordination with its owner.
- **WSL→Windows handoff:** affected versions look for a Linux daemon socket.
  Check dry-run and execution results; use Mac↔Windows routes or Windows-bridge
  direct checks while affected. Report remaining route gaps as BLOCKED.
