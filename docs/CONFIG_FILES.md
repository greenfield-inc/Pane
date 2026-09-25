# Config File Detection

Pane automatically detects workspace configuration files at your repository root and uses them to provide default scripts for session setup, the Play button, and cleanup on archive. This lets teams share workspace configuration via git — commit the file, push, and every teammate gets the same setup.

## Supported Files

Pane checks for these files in priority order. The first file found with at least one script defined wins:

| Priority | File | Format | Origin |
|----------|------|--------|--------|
| 1 | `pane.json` | JSON | Pane's native format |
| 2 | `conductor.json` | JSON | [Conductor.build](https://conductor.build) |
| 3 | `.gitpod.yml` | YAML | [Gitpod](https://gitpod.io) |
| 4 | `.devcontainer/devcontainer.json` | JSON | [Dev Containers](https://containers.dev) |

If none of these exist, Pane falls back to checking for `scripts/pane-run-script.js` in the worktree (the legacy auto-generated script).

## pane.json

This is Pane's native config format. It follows the same schema as [conductor.json](https://docs.conductor.build/core/conductor-json), so teams using Conductor can switch to Pane without changing their config.

### Schema

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev",
    "archive": "pnpm cleanup"
  },
  "runScriptMode": "concurrent"
}
```

All fields are optional.

### Fields

#### `scripts.setup`

Runs automatically when a new worktree/session is created. Use for dependency installation, database setup, environment configuration, etc.

**Examples:**
```json
"setup": "npm install"
"setup": "pnpm install && pnpm db:migrate"
"setup": "bundle install && rails db:setup"
```

#### `scripts.run`

Runs when you click the **Play** button in the panel tab bar (or press `Ctrl+Shift+D`). Use for starting dev servers, test watchers, or any long-running process.

Pane sets `PANE_PORT` to the first of a block of 10 ports picked from the pane's id (range 3000–8999), so dev servers in parallel panes rarely collide.

**Examples:**
```json
"run": "pnpm dev"
"run": "npm run dev -- --port $PANE_PORT"
"run": "concurrently \"npm run server\" \"npm run worker\""
```

#### `scripts.archive`

Runs before a worktree is deleted when you archive a session. Use for cleaning up external resources — dropping test databases, revoking tokens, stopping background services.

**Examples:**
```json
"archive": "npm run db:teardown"
"archive": "docker compose down"
```

#### `runScriptMode`

Controls behavior when a new run script starts while one is already running.

| Value | Behavior |
|-------|----------|
| `"concurrent"` | (Default) New script starts alongside existing ones |
| `"nonconcurrent"` | Existing script is stopped before starting the new one |

> **Note:** `runScriptMode` is detected but not yet enforced. This will be implemented in a future release.

## How Scripts Map to Pane

Each config file format maps to Pane's three lifecycle hooks differently:

| Lifecycle | pane.json / conductor.json | .gitpod.yml | devcontainer.json |
|-----------|---------------------------|-------------|-------------------|
| **Setup** (worktree creation) | `scripts.setup` | First task's `init` | `postCreateCommand` |
| **Run** (Play button) | `scripts.run` | First task's `command` | `postStartCommand` |
| **Archive** (session deletion) | `scripts.archive` | — | — |

## Override Model

Pane follows the same override model as Conductor:

```
Project Settings (UI) > Config File > Nothing
```

1. **If you set a value in Project Settings**, it always wins — the config file is ignored for that field
2. **If Project Settings is empty**, Pane uses the config file value
3. **If neither exists**, no script runs (except for the Play button, which falls back to Claude-generated setup)

This means config files provide **team-shared defaults** that individual users can override locally through the UI.

### Per-Field Override

Each script field is independent. You can override `run` in Project Settings while still using `setup` from `pane.json`:

```
Build Script:  empty → uses pane.json scripts.setup
Run Commands:  "npm run dev:custom" → overrides pane.json
Archive Script: empty → uses pane.json scripts.archive
```

## Branch-Local Config

Config files are read from the **session's worktree**, not the project root. This means:

- If a branch modifies `pane.json`, that branch's sessions use the modified config
- You can test config changes in a worktree before merging to main
- Different branches can have different setup/run/archive scripts

## Quick Start

### 1. Create a `pane.json` in your repo root

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev"
  }
}
```

### 2. Commit and push

```bash
git add pane.json
git commit -m "Add pane workspace config"
git push
```

### 3. That's it

When your teammates pull, Pane will automatically:
- Run `pnpm install` when they create a new session
- Run `pnpm dev` when they click Play
- Show "From pane.json" in Project Settings so they know where the scripts come from

### Already using another tool?

If your repo already has a `conductor.json`, `.gitpod.yml`, or `.devcontainer/devcontainer.json`, Pane will detect and use it automatically. No changes needed.

## Visibility

### Project Settings

When Pane detects a config file, Project Settings shows:
- An info banner identifying which file was detected
- "From pane.json" badges beneath empty script fields, previewing the command that will run
- Updated tooltips explaining the fallback behavior

### Play Button

The Play button tooltip shows exactly what will run and where it came from:
- **With config:** "Run: pnpm dev" with "from pane.json" subtitle
- **Without config:** "Set up run script (via Claude)" — launches AI-assisted setup

## Examples

### Node.js / TypeScript project

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev",
    "archive": "rm -rf node_modules/.cache"
  }
}
```

### Python / Django project

```json
{
  "scripts": {
    "setup": "pip install -r requirements.txt && python manage.py migrate",
    "run": "python manage.py runserver 0.0.0.0:8000",
    "archive": "python manage.py flush --noinput"
  }
}
```

### Monorepo with multiple services

```json
{
  "scripts": {
    "setup": "pnpm install --frozen-lockfile",
    "run": "concurrently \"pnpm --filter api dev\" \"pnpm --filter web dev\"",
    "archive": "docker compose -f docker-compose.test.yml down -v"
  },
  "runScriptMode": "nonconcurrent"
}
```

### Migrating from Conductor

If you already have a `conductor.json`, it works as-is — the schema is identical. You can optionally rename it to `pane.json`. If both files exist, `pane.json` wins.
