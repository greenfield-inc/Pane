#!/usr/bin/env node
// pane-pre-push: the marker scripts/git-hooks/pre-push looks for before running this.
// The pre-push hook (scripts/git-hooks/pre-push, installed by `pnpm run setup`).
// It lints the files the pushed commits change and, when they touch code or
// config, runs the type check CI runs (`pnpm typecheck`), side by side, in a few
// seconds. CI still runs every check.
//
// Git passes one line per pushed ref on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// A ref whose remote sha is an ancestor of the pushed commit is checked on
// that range. A new branch, a rewritten branch or an unknown remote commit is
// checked from where it left origin/main; without origin/main, everything is.
// Files that only origin/main changed (a merge of main) are left to CI.
//
// --dry-run prints the plan without running it.
// `git push --no-verify` skips the hook.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ZERO = /^0+$/;
// Past this many files, lint the whole tree: Windows caps a command line at 32K.
const MAX_LINT_FILES = 300;
const LINTABLE = /\.(?:[cm]?[jt]sx?)$/;
// A change to one of these can change what the type check reports.
const TYPED = /(?:\.(?:[cm]?[jt]sx?|json)|^pnpm-lock\.yaml)$/;

const dryRun = process.argv.includes('--dry-run');

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function refuse(message) {
  console.error(`pre-push: ${message}\nTo push without the check: git push --no-verify`);
  process.exit(1);
}

const root = git(['rev-parse', '--show-toplevel'])?.trim();
if (!root) refuse('this is not inside a git work tree.');
process.chdir(root);
const head = git(['rev-parse', 'HEAD'])?.trim();

/** { path, deleted } for each file changed between two commits, renames as delete plus add. */
function changes(from, to) {
  const listing = git(['diff', '--name-status', '--no-renames', '-z', from, to]);
  if (listing === null) refuse(`could not list the files changed between ${from} and ${to}.`);
  const fields = listing.split('\0');
  const files = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    files.push({ path: fields[index + 1], deleted: fields[index] === 'D' });
  }
  return files;
}

function isAncestor(older, newer) {
  return spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
}

const pushed = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map((line) => {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
  return { localRef, localSha, remoteRef, remoteSha };
});

let changed = [];
let everything = false;
for (const ref of pushed) {
  if (ZERO.test(ref.localSha)) continue; // deleting a remote branch
  if (ref.localSha !== head) {
    console.log(`pre-push: skipped ${ref.localRef}: it is not checked out, so the files on disk are not its files. CI checks it.`);
    continue;
  }
  const mainBase = git(['merge-base', ref.localSha, 'origin/main'])?.trim();
  const remoteKnown = !ZERO.test(ref.remoteSha) && isAncestor(ref.remoteSha, ref.localSha);
  const from = remoteKnown ? ref.remoteSha : mainBase;
  if (from) {
    const onBranch = mainBase && from !== mainBase ? new Set(changes(mainBase, ref.localSha).map((file) => file.path)) : null;
    changed.push(...changes(from, ref.localSha).filter((file) => !onBranch || onBranch.has(file.path)));
    console.log(`pre-push: ${ref.remoteRef} from ${from.slice(0, 12)}`);
  } else {
    everything = true;
    console.log(`pre-push: ${ref.remoteRef} has no known base (no origin/main), so everything is checked.`);
  }
}
changed = [...new Map(changed.map((file) => [file.path, file])).values()];

const present = changed.filter((file) => !file.deleted).map((file) => file.path);
const lintFiles = present.filter((file) => LINTABLE.test(file));
const lintAll = everything || lintFiles.length > MAX_LINT_FILES;
// Deleted files count: removing a module can break the files that import it.
const typecheck = everything || changed.some((file) => TYPED.test(file.path));

// Worktrees share the clone's hook, but each has its own node_modules.
if (!dryRun && (lintAll || lintFiles.length > 0 || typecheck) && !fs.existsSync('node_modules/.bin')) {
  console.log('pre-push: skipped: this worktree has no node_modules. Run pnpm install to check pushes here; CI checks this one.');
  process.exit(0);
}

// The tools read the disk, so an uncommitted edit to a checked file would be
// checked in place of the pushed one.
const status = git(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=no']);
if (status === null) refuse('could not list uncommitted changes (git status failed).');
const dirty = status.split('\0').filter(Boolean).map((entry) => entry.slice(3));
const checkedDirty = dirty.filter((file) => (lintAll ? LINTABLE.test(file) : lintFiles.includes(file))
  || (typecheck && TYPED.test(file)));
if (checkedDirty.length > 0) {
  refuse(`these files have uncommitted changes, and the checks would read them instead of what you are pushing:\n  ${checkedDirty.join('\n  ')}\nCommit or stash them, then push again.`);
}

const checks = [];
if (lintAll) {
  checks.push({ name: 'oxlint (whole tree)', command: process.execPath, args: ['scripts/oxlint.mjs'] });
} else if (lintFiles.length > 0) {
  checks.push({
    name: `oxlint (${lintFiles.length} file${lintFiles.length === 1 ? '' : 's'})`,
    command: process.execPath,
    // Every file may be one .oxlintrc.json ignores; that is a pass, not an error.
    args: ['node_modules/oxlint/bin/oxlint', '--config', '.oxlintrc.json', '--no-error-on-unmatched-pattern', ...lintFiles],
  });
}
if (lintAll || lintFiles.length > 0) {
  checks.push({ name: 'agent facts', command: process.execPath, args: ['scripts/check-agent-names.mjs'] });
  checks.push({ name: 'boundary decoder lint conformance', command: process.execPath, args: ['scripts/check-boundary-decoder-conformance.mjs'] });
}
// Format: oxfmt --check on the changed files goes here once the repo has a formatter.
if (typecheck) {
  // The whole repository: bun check takes a few seconds, and it is CI's own command.
  checks.push({ name: 'typecheck', command: 'pnpm', args: ['run', '--silent', 'typecheck'] });
}

if (checks.length === 0) {
  console.log('pre-push: nothing to lint or type check in this push.');
  process.exit(0);
}
if (dryRun) {
  for (const check of checks) {
    console.log(`${check.name}: ${check.command === process.execPath ? 'node' : check.command} ${check.args.join(' ')}`);
  }
  process.exit(0);
}

const started = Date.now();
const results = await Promise.all(checks.map((check) => new Promise((resolve) => {
  const checkStarted = Date.now();
  // pnpm is a .cmd shim on Windows, which needs a shell; file names only reach node.
  const child = spawn(check.command, check.args, { cwd: root, shell: process.platform === 'win32' && check.command === 'pnpm' });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => resolve({ check, ok: false, output: `${output}could not start: ${error.message}\n`, seconds: 0 }));
  child.on('close', (code) => resolve({ check, ok: code === 0, output, seconds: (Date.now() - checkStarted) / 1000 }));
})));

for (const result of results) {
  if (!result.ok) process.stdout.write(result.output);
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.check.name} (${result.seconds.toFixed(1)}s)`);
}
const failed = results.filter((result) => !result.ok);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  refuse(`${failed.map((result) => result.check.name).join(', ')} failed in ${seconds}s; the output is above.`);
}
console.log(`pre-push: passed in ${seconds}s. CI runs the rest.`);
