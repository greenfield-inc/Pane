// The pre-push hook and its installer, in a throwaway repository: the hook's
// plan (--dry-run) for the pushes git hands it, its exit status when a check
// fails, and where the installer writes the hook.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(scripts, 'pre-push.mjs');
// No global or system git config (hooks paths, commit signing) reaches the tests.
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
const ZERO = '0'.repeat(40);
let repo;

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(file, content = 'export const value = 1;\n') {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(message) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Runs the hook for one pushed ref; returns its exit status and output. */
function runHook(remoteSha, args = [], localSha = git('rev-parse', 'HEAD')) {
  const result = spawnSync(process.execPath, [hook, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env,
    input: `refs/heads/topic ${localSha} refs/heads/topic ${remoteSha}\n`,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

/** The hook's dry-run plan for one pushed ref: its exit status and the check names it lists. */
function plan(remoteSha, localSha = git('rev-parse', 'HEAD')) {
  const result = runHook(remoteSha, ['--dry-run'], localSha);
  const checks = result.output.split('\n').filter((line) => /^[a-z][^:]*: (?:node|pnpm) /.test(line));
  return { ...result, checks };
}

const lintedFiles = (checks) => checks.find((line) => line.startsWith('oxlint'))?.split(' --no-error-on-unmatched-pattern ')[1] ?? '';
const names = (checks) => checks.map((line) => line.slice(0, line.indexOf(':')));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  write('main/src/kept.ts');
  write('main/src/old name.ts');
  write('frontend/src/gone.ts');
  write('README.md', '# readme\n');
  git('update-ref', 'refs/remotes/origin/main', commit('base'));
  git('checkout', '-q', '-b', 'topic');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a new branch is checked from where it left origin/main, with renames, deletions and spaces', () => {
  git('mv', 'main/src/old name.ts', 'main/src/new name.ts');
  fs.rmSync(path.join(repo, 'frontend/src/gone.ts'));
  write('README.md', '# changed\n');
  commit('first');
  write('packages/runpane/src/cli.ts');
  commit('second');

  const { status, checks } = plan(ZERO);
  assert.equal(status, 0);
  assert.equal(lintedFiles(checks), 'main/src/new name.ts packages/runpane/src/cli.ts');
  assert.deepEqual(names(checks), ['oxlint (2 files)', 'agent facts', 'boundary decoder lint conformance', 'typecheck']);
});

test('a push onto a branch the remote has checks only the new commits', () => {
  write('frontend/src/first.ts');
  const remote = commit('first');
  write('main/src/second.ts');
  commit('second');

  const { checks } = plan(remote);
  assert.equal(lintedFiles(checks), 'main/src/second.ts');
  assert.deepEqual(names(checks), ['oxlint (1 file)', 'agent facts', 'boundary decoder lint conformance', 'typecheck']);
});

test('a merge of origin/main checks only the files the branch changes', () => {
  write('main/src/mine.ts');
  const remote = commit('mine');
  git('checkout', '-q', 'main');
  write('frontend/src/theirs.ts');
  git('update-ref', 'refs/remotes/origin/main', commit('theirs'));
  git('checkout', '-q', 'topic');
  write('main/src/mine.ts', 'export const value = 2;\n');
  commit('edit');
  git('merge', '-q', '--no-edit', 'origin/main');

  const { checks } = plan(remote);
  assert.equal(lintedFiles(checks), 'main/src/mine.ts');
});

test('a rewritten branch is checked from where it left origin/main', () => {
  write('frontend/src/first.ts');
  const replaced = commit('first');
  git('reset', '-q', '--hard', 'origin/main');
  write('main/src/second.ts');
  commit('second');

  const { checks } = plan(replaced);
  assert.equal(lintedFiles(checks), 'main/src/second.ts');
});

test('deleting a module type checks without linting it', () => {
  fs.rmSync(path.join(repo, 'frontend/src/gone.ts'));
  commit('delete');
  assert.deepEqual(names(plan(ZERO).checks), ['typecheck']);
});

test('a docs-only push and a branch deletion check nothing', () => {
  write('README.md', '# changed\n');
  commit('docs');
  assert.match(plan(ZERO).output, /nothing to lint or type check/);
  assert.match(plan(git('rev-parse', 'HEAD'), ZERO).output, /nothing to lint or type check/);
});

test('without origin/main a new branch checks everything', () => {
  git('update-ref', '-d', 'refs/remotes/origin/main');
  write('main/src/second.ts');
  commit('second');

  const { checks } = plan(ZERO);
  assert.equal(checks[0], 'oxlint (whole tree): node scripts/oxlint.mjs');
  assert.deepEqual(names(checks), ['oxlint (whole tree)', 'agent facts', 'boundary decoder lint conformance', 'typecheck']);
});

test('an uncommitted edit to a checked file refuses the push', () => {
  write('main/src/second.ts');
  commit('second');
  write('main/src/second.ts', 'export const value = 2;\n');

  const { status, output } = plan(ZERO);
  assert.equal(status, 1);
  assert.match(output, /uncommitted changes[^]*main\/src\/second\.ts/);
});

test('a failing check refuses the push with its output', () => {
  write('node_modules/.bin/.keep', '');
  write('node_modules/oxlint/bin/oxlint', "console.log('stub: no-debugger'); process.exit(1);\n");
  write('scripts/check-agent-names.mjs', '');
  write('scripts/check-boundary-decoder-conformance.mjs', '');
  write('package.json', JSON.stringify({ scripts: { typecheck: 'node -e ""' } }));
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'tools');
  write('main/src/second.ts');
  commit('second');

  const { status, output } = runHook(ZERO);
  assert.equal(status, 1);
  assert.match(output, /stub: no-debugger/);
  assert.match(output, /FAIL oxlint/);
  assert.match(output, /ok {3}typecheck/);
});

test('a worktree without node_modules pushes with a note that it was not checked', () => {
  write('main/src/second.ts');
  commit('second');

  const { status, output } = runHook(ZERO);
  assert.equal(status, 0);
  assert.match(output, /skipped: this worktree has no node_modules/);
});

function installHook(globalConfig = os.devNull) {
  for (const file of ['install-git-hooks.mjs', 'git-hooks/pre-push']) {
    write(`scripts/${file}`, fs.readFileSync(path.join(scripts, file), 'utf8'));
  }
  return spawnSync(process.execPath, ['scripts/install-git-hooks.mjs'], {
    cwd: repo, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: globalConfig },
  });
}

test('the installer writes the hook into the clone, and the hook runs only a script with the marker', () => {
  assert.equal(installHook().status, 0);
  const installed = path.join(repo, '.git/hooks/pre-push');
  write('scripts/pre-push.mjs', "console.log('ran'); process.exit(1);\n");
  const unmarked = spawnSync('sh', [installed], { cwd: repo, encoding: 'utf8', env, input: '' });
  assert.equal(unmarked.status, 0);
  assert.equal(unmarked.stdout, '');

  write('scripts/pre-push.mjs', "// pane-pre-push\nconsole.log('ran'); process.exit(1);\n");
  const marked = spawnSync('sh', [installed], { cwd: repo, encoding: 'utf8', env, input: '' });
  assert.equal(marked.status, 1);
  assert.equal(marked.stdout, 'ran\n');
});

test('the installer leaves a hooks folder outside the clone untouched', () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-shared-hooks-'));
  const globalConfig = path.join(shared, 'gitconfig');
  fs.writeFileSync(globalConfig, `[core]\n\thooksPath = ${shared.replaceAll('\\', '/')}\n`);
  try {
    const result = installHook(globalConfig);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Skipped the pre-push hook: core\.hooksPath/);
    assert.equal(fs.existsSync(path.join(shared, 'pre-push')), false);
  } finally {
    fs.rmSync(shared, { recursive: true, force: true });
  }
});
