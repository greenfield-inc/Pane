# Importing from another tool

Pane can adopt a git worktree created by Conductor, another orchestrator, or by hand. An adopted Pane points at the existing directory while ownership stays with the tool that created it.

## Adopt a worktree

First save the base repository in Pane. Then adopt one of that repository's registered worktrees:

```bash
runpane panes adopt \
  --repo active \
  --path /absolute/path/to/existing-worktree \
  --name existing-work \
  --agent codex \
  --resume 00000000-0000-0000-0000-000000000000 \
  --yes \
  --json
```

Use `--dry-run` first to validate the path without creating a Pane. `--folder <name>` places the Pane in a top-level sidebar folder, and `--no-pinned` opts out of the default pin. The command resolves symlinks before storing the path and refuses directories that are not registered worktrees of the selected repository or are already registered in Pane.

When `--resume` is present, Pane persists the agent session id and stages that agent's resume command in the terminal without pressing Enter. Review the command and press Enter when ready. Pass `--launch` to run it immediately. Do not drive the same transcript from two applications at the same time because both may append to the same transcript.

The JSON form supports the same fields:

```json
{
  "repo": "active",
  "panes": [
    {
      "path": "/absolute/path/to/existing-worktree",
      "name": "existing-work",
      "folder": "in-review",
      "pinned": true,
      "tool": { "agent": "codex" },
      "resume": "00000000-0000-0000-0000-000000000000",
      "launch": false
    }
  ]
}
```

Run it with `runpane panes adopt --from-json panes.json --yes --json`.

## Ownership and lifecycle

Pane stores `worktree_ownership: "external"` for adopted Panes. The sidebar labels them **External**, and `runpane panes list --json` returns `ownership: "external"` (ordinary Pane worktrees return `"pane"`). This marker is separate from main-repository mode and from the worktree name.

Pane never creates, file-syncs, builds, or recreates an external directory, and removes one only when asked. Archiving or permanently deleting an adopted Pane only removes Pane's record, unless you archive it with `runpane panes archive --pane <id> --remove-worktree`: that runs the same safety check as a Pane-managed worktree (uncommitted, untracked, and unpushed work block the archive without `--force`; untracked files under the root `.codex/`, `.claude/`, and `.agent-farm/` directories are ignored) and then removes the worktree. The local branch is kept. Deleting its saved project also leaves the directory and git worktree registration untouched. Restoring an adopted Pane whose directory has disappeared succeeds and displays `External worktree directory is missing`; Pane does not recreate it. Automatic checkpoint commits default to disabled for adopted Panes.

Otherwise the tool that owns the worktree remains responsible for its archive and deletion lifecycle, and `runpane panes archive --dry-run --pane <id> --json` reports worktree cleanup as not applicable. Restoring an adopted Pane whose worktree was removed does not recreate it; `git worktree add <path> <branch>` does.

## Conductor imports

The bulk `runpane import conductor` workflow is planned as a follow-up to the core adoption support. Until then, enumerate active Conductor workspaces and call `panes adopt` for each one. Pane already reads `conductor.json` for project scripts, but adoption deliberately does not run setup/build scripts.
