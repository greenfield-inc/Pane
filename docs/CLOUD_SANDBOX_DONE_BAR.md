# Real-user done bar (Red, 2026-10-03, revised 10:40 AM PT)

Set by Red on 2026-10-03 at 10:40 AM PT. It replaces both the 10:23 AM version and done-when tests 1-5 from the Oct 1 reduced scope.

**Sandboxes stay a generic remote (Parsa's simpler bar). Doppler injection and implicit GitHub auth stay out of scope.**

Every step is done through the real Windows UI:

1. The Open project, New project and GitHub buttons on the main Pane page work on the active host, not the local machine.
2. Clone from GitHub clones montlakev2 onto the sandbox. Implicit gh auth is not required: an unauthenticated user gets whatever error they would normally get. Agree with Red on what that error and UX actually are before building, in case something custom is needed.
3. A new pane lands on the sandbox in its correct worktree. Claude Code, Codex and Terminal in that pane all work: they run on the sandbox, in the worktree, and their basic functions are confirmed.
4. Doppler injection is skipped. The user runs `doppler login` themselves.
5. Implicit GitHub login is skipped. The user signs the sandbox in to GitHub when they create it, like any remote. They probably need a terminal on the host before opening a repo pane. State whether Pane already supports this.
6. To finish, an agent edits a file, commits, pushes a branch and opens a draft PR on montlakev2.

## Done-when additions (Red, 2026-10-03 1:32 PM PT; E7 + E8)

7. Through the real Windows UI, Red sets a local start script that prints a test variable. The variable is present on the sandbox and in a pane terminal, checked by name only (the value is never printed).
8. The Create dialog shows the warning, with links, when either the GitHub token or the local start script is unset. The warning goes away once both are set.

### E7. Local start script (Red, 2026-10-03 1:32 PM PT; cloud sandboxes; in the final build before Run 8)

- **Where:** Settings > Cloud sandboxes > "Local start script". The user writes a script there. It runs on the user's LOCAL machine (Windows: PowerShell or cmd; macOS/Linux: sh).
- **When:** on every sandbox Create and Start, BEFORE the remote startup script (E5).
- **Ordering vs E5 (E7-A ruling, relay 1:43 PM PT; the parent agent's ruling, within Red's direction):** E5's boot run stays. After the desktop installs the fresh local-env on Create/Start, E5 RE-RUNS ONCE if the startup-script sha OR the local-env sha differs from what the boot run used. Nothing runs twice when nothing changed.
- **Output:** stdout lines in KEY=VALUE form are sent to the sandbox as an owner-only env file, e.g. `~/.config/runpane-cloud/local-env`, mode 0600.
- **Use:** the remote startup script (E5) and agent/terminal shells source that file.
- **Secrets:** values are never logged or printed. Logs show key names only.
- **Failure:** it has a timeout, and failures show on the sandbox row like E5's.
- **Docs example:** `doppler configure get token --plain` -> `DOPPLER_TOKEN=...`

### E8. Setup warning on Create (Red, 2026-10-03 1:32 PM PT)

- The Create sandbox dialog shows a NON-BLOCKING warning when no GitHub token (E6) is set, no local start script (E7) is set, or both are missing.
- Each missing item gets a link that opens Settings with focus on that field.
- The warning goes away once both are set.

## Reporting rule

Every done report lists each real-user UI step that was exercised, with evidence from the actual Windows UI (screenshots or a recording). A step without UI evidence counts as not done. The result is audited element by element by cs-auditor.

## Superseded: 10:23 AM PT version

The 10:23 AM version, which brought Doppler secrets and GitHub credentials back into scope, is superseded by this revision and no longer applies.

Design brief for this bar (awaiting approval): [CLOUD_SANDBOX_REAL_USER_BRIEF.md](CLOUD_SANDBOX_REAL_USER_BRIEF.md).
