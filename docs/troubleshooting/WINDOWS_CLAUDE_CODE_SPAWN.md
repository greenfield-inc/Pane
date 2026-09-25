# Windows Claude Code Spawn Issue - RESOLVED

## Status: ✅ FIXED

Both issues have been resolved. Claude Code now spawns correctly on Windows.

## Note: the original reproduction no longer applies

The failure described below was reproduced against a copy of Claude Code installed **inside
Pane's own `node_modules`** — Pane declared `@anthropic-ai/claude-code` as a dependency, so
`Pane/node_modules/.bin/claude` existed and could win PATH resolution during development.
That dependency has since been removed (nothing ever imported it; Pane spawns the user's
own CLI), so the specific `MODULE_NOT_FOUND` path shown below — resolving into Pane's pnpm
store — can no longer occur.

**The fixes described here are still live and still required.** Both apply to any
globally installed `claude`:

- npm/pnpm bin stubs are shell scripts on Windows, so `node-pty` cannot execute them
  directly (error code 193). The proactive Node.js fallback in `AbstractCliManager.ts`
  handles this.
- Those stubs resolve their target through `$basedir`-relative paths, which break when the
  process is spawned with a worktree as `cwd`. `findCliNodeScript()` in `nodeFinder.ts`
  parses the stub and invokes the resolved `.js` file directly.

Read the sections below as the rationale for that code. Only the reproduction environment
is out of date.

## Problem Summary

Claude Code was failing to spawn properly on Windows when Pane runs it in a worktree directory different from where `@anthropic-ai/claude-code` is installed.

## Root Cause Analysis

### Issue 1: Error Code 193 (Fixed)

**Error:** `Failed to spawn Claude Code: Cannot create process, error code: 193`

**Cause:** Error code 193 on Windows means "not a valid Win32 application". This occurs when trying to execute a shell script (like npm bin stubs) directly via `node-pty` instead of through a shell or Node.js.

**Fix Applied:** The PTY host classifies the spawn failure as `E193` (`classifySpawnError()` in `main/src/ptyHost/ptyHostMain.ts`). `AbstractCliManager.ts` matches the error message (`error code: 193` or `not a valid Win32 application`) and retries with the Node.js fallback.

**Location:** `main/src/ptyHost/ptyHostMain.ts` and `main/src/services/panels/cli/AbstractCliManager.ts`

### Issue 2: Module Not Found (Fixed)

**Error:**
```
Error: Cannot find module 'C:\Users\<user>\<repo>\worktrees\@anthropic-ai\claude-code\cli.js'
```

**Cause:** The npm bin stub at `node_modules/.bin/claude` uses a relative path:
```bash
exec node "$basedir/../@anthropic-ai/claude-code/cli.js" "$@"
```

When the `cwd` is set to the worktree directory, the relative path resolves incorrectly.

## Solution Applied

### Fix 1: Proactive Windows Node.js Fallback

On Windows, we now proactively use the Node.js fallback instead of waiting for failures:

```typescript
// In spawnPtyProcess() at main/src/services/panels/cli/AbstractCliManager.ts
if (os.platform() === 'win32') {
  this.logger?.verbose(`[${this.getCliToolName()}] Windows detected, using Node.js fallback proactively`);
  nodeFallbackTools.add(needsNodeFallbackKey);
}
```

This bypasses the problematic shell script execution entirely.

### Fix 2: Enhanced pnpm Path Resolution

The `findCliNodeScript()` function in `main/src/utils/nodeFinder.ts` was enhanced to properly handle pnpm's node_modules structure:

1. **Detects pnpm directory**: Checks for `node_modules/.pnpm` directory
2. **Known package mappings**: Has specific mappings for Claude Code and Codex packages
3. **Generic pnpm search**: Falls back to searching for any matching package
4. **Proper path construction**: Correctly builds paths like:
   ```
   node_modules/.pnpm/@anthropic-ai+claude-code@2.0.0/node_modules/@anthropic-ai/claude-code/cli.js
   ```

## Technical Details

### npm Bin Stub Structure (Windows)

The file at `Pane/node_modules/.bin/claude` is a shell script that:
1. Sets `NODE_PATH` with pnpm-specific paths
2. Executes: `node "$basedir/../@anthropic-ai/claude-code/cli.js" "$@"`

The `$basedir` is the directory containing the script, but when node-pty spawns with a different `cwd`, the relative path resolution breaks.

### Why the Proactive Approach?

The reactive fallback (catching error code 193) wasn't enough because:
- The spawn could "succeed" from node-pty's perspective
- But the process would exit immediately with code 1 (MODULE_NOT_FOUND)
- By the time we knew it failed, it was too late to retry

By proactively using Node.js on Windows, we avoid the shell script entirely and directly invoke the CLI script with the correct absolute path.

## Files Modified

1. `main/src/services/panels/cli/AbstractCliManager.ts` - Added:
   - Proactive Windows Node.js fallback detection
   - Error code 193 message matching (reactive fallback)
2. `main/src/ptyHost/ptyHostMain.ts` - `classifySpawnError()` reports error 193 as `E193`
3. `main/src/utils/nodeFinder.ts` - Enhanced `findCliNodeScript()` with:
   - pnpm structure detection
   - Known package mappings for Claude Code and Codex
   - Generic pnpm package search
   - Standard npm path resolution

## Debug Logs to Check

- `backend-debug.log` - Look for:
  - `Windows detected, using Node.js fallback proactively`
  - `Detected pnpm structure`
  - `Found pnpm CLI script at:`
  - `Using Node.js:`

## Test Commands

```bash
# Rebuild main process after changes
pnpm build:main

# Run in dev mode
pnpm electron-dev

# Check logs (PowerShell)
Select-String -Path backend-debug.log -Pattern "Claude|spawn|pnpm|NodeFinder"
```
