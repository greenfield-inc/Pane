// The pre-push hook's plan (--dry-run) for the pushes git hands it, in a
// throwaway repository: which files it lints and which projects it type checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pre-push.mjs');
const ZERO = '0'.repeat(40);
let repo;

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
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

/** The hook's dry-run plan for one pushed ref: its exit status and the check names it lists. */
function plan(remoteSha, localSha = git('rev-parse', 'HEAD')) {
  const result = spawnSync(process.execPath, [hook, '--dry-run'], {
    cwd: repo,
    encoding: 'utf8',
    input: `refs/heads/topic ${localSha} refs/heads/topic ${remoteSha}\n`,
  });
  const checks = result.stdout.split('\n').filter((line) => /^[a-z][^:]*: node /.test(line));
  return { status: result.status, checks, output: result.stdout + result.stderr };
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
  assert.deepEqual(names(checks), [
    'oxlint (2 files)',
    'agent facts',
    'typecheck main',
    'typecheck frontend',
    'typecheck frontend node config',
    'typecheck renderer tests',
    'typecheck runpane',
  ]);
});

test('a push onto a branch the remote has checks only the new commits', () => {
  write('frontend/src/first.ts');
  const remote = commit('first');
  write('main/src/second.ts');
  commit('second');

  const { checks } = plan(remote);
  assert.equal(lintedFiles(checks), 'main/src/second.ts');
  assert.deepEqual(names(checks), ['oxlint (1 file)', 'agent facts', 'typecheck main']);
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
  assert.equal(checks.length, 7);
});

test('an uncommitted edit to a checked file refuses the push', () => {
  write('main/src/second.ts');
  commit('second');
  write('main/src/second.ts', 'export const value = 2;\n');

  const { status, output } = plan(ZERO);
  assert.equal(status, 1);
  assert.match(output, /uncommitted changes[^]*main\/src\/second\.ts/);
});
