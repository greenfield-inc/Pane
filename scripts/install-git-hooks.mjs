#!/usr/bin/env node
// Installs scripts/git-hooks/pre-push as this clone's pre-push hook (`pnpm run
// setup` runs it). Worktrees share the clone's hooks. It writes only inside
// this clone's git directory. When core.hooksPath points elsewhere (a hooks
// folder every repository shares) it changes nothing and prints how to give
// this clone its own; when a pre-push hook that is not Pane's is already there,
// it keeps it and prints the line to add to it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'pane-pre-push';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'scripts', 'git-hooks', 'pre-push');
const addLine = 'node "$(git rev-parse --show-toplevel)/scripts/pre-push.mjs" "$@" || exit 1';

function gitPath(...args) {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', ...args], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? path.resolve(result.stdout.trim()) : null;
}

// --git-path follows core.hooksPath and resolves a worktree to its clone.
const target = gitPath('--git-path', 'hooks/pre-push');
const commonDir = gitPath('--git-common-dir');
if (!target || !commonDir) {
  console.log('Skipped the pre-push hook: this is not a git clone.');
  process.exit(0);
}

const relative = path.relative(commonDir, target);
if (relative.startsWith('..') || path.isAbsolute(relative)) {
  console.log(`Skipped the pre-push hook: core.hooksPath sends this clone's hooks to ${path.dirname(target)}, outside the clone, where other repositories may use them. To check pushes from this clone only, give it its own hooks folder (it then stops using that one) and install again:\n  git config core.hooksPath "$(git rev-parse --path-format=absolute --git-common-dir)/hooks" && node scripts/install-git-hooks.mjs`);
  process.exit(0);
}
if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(MARKER)) {
  console.log(`Kept your pre-push hook at ${target}. To run Pane's checks too, add this line to it:\n  ${addLine}`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
fs.chmodSync(target, 0o755);
console.log(`Installed the pre-push hook at ${target}: it lints and type checks what you push. git push --no-verify skips it.`);
