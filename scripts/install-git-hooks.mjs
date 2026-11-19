#!/usr/bin/env node
// Installs scripts/git-hooks/pre-push as this clone's pre-push hook (`pnpm run
// setup` runs it). A pre-push hook that is not ours is kept, and this prints
// how to run ours from it. Worktrees share the clone's hooks.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'pane-pre-push';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'scripts', 'git-hooks', 'pre-push');

// --git-path follows core.hooksPath and resolves a worktree to its clone.
const located = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'], { cwd: repoRoot, encoding: 'utf8' });
if (located.status !== 0) {
  console.log('Skipped the pre-push hook: this is not a git clone.');
  process.exit(0);
}
const target = located.stdout.trim();

if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(MARKER)) {
  console.log(`Kept your pre-push hook at ${target}. To run Pane's checks too, add this line to it:\n  node "$(git rev-parse --show-toplevel)/scripts/pre-push.mjs" "$@" || exit 1`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
fs.chmodSync(target, 0o755);
console.log(`Installed the pre-push hook at ${target}: it lints and type checks what you push. git push --no-verify skips it.`);
