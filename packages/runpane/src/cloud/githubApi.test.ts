import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { bundleScript } from './github';
import { pushBundle } from './githubApi';

/**
 * The real git round trip of `runpane cloud git push`, against a local bare repository standing in for
 * GitHub: the sandbox's bundle script, reassembly, then the laptop's shallow fetch and push.
 */

const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.test'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

function commit(cwd: string, file: string): void {
  execFileSync('sh', ['-c', `echo ${file} > ${file}`], { cwd });
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
}

async function world() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-gitpush-'));
  const remote = path.join(root, 'github', 'acme', 'app.git');
  await fs.mkdir(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'master');
  git(remote, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const sandbox = path.join(root, 'sandbox');
  git(root, 'clone', '-q', remote, sandbox);
  git(sandbox, 'checkout', '-q', '-b', 'master');
  commit(sandbox, 'base');
  commit(sandbox, 'second');
  git(sandbox, 'push', '-q', 'origin', 'master');
  return { root, remote, sandbox };
}

function runBundle(sandbox: string, branch: string, xfer: string) {
  const out = execFileSync('bash', ['-c', bundleScript(sandbox, branch, xfer)], { encoding: 'utf8' });
  const line = out.split('\n').find((candidate) => candidate.startsWith('RP_BUNDLE '));
  assert.ok(line, out);
  // SAFETY: the RP_BUNDLE line is the JSON object bundleScript prints with exactly these fields.
  return JSON.parse(line.slice('RP_BUNDLE '.length)) as { head: string; prerequisites: string[]; commits: number; size: number; parts: string[] };
}

test('a branch bundled in the sandbox lands on the remote under the target ref, and only there', async () => {
  const { root, remote, sandbox } = await world();
  git(sandbox, 'checkout', '-q', '-b', 'feature');
  commit(sandbox, 'feature-1');
  commit(sandbox, 'feature-2');
  const xfer = path.join(root, 'xfer');
  const bundle = runBundle(sandbox, 'feature', xfer);
  assert.equal(bundle.commits, 2);
  assert.deepEqual(bundle.prerequisites, [git(sandbox, 'rev-parse', 'master')]);
  const data = Buffer.concat(await Promise.all(bundle.parts.map((part) => fs.readFile(path.join(xfer, part)))));
  assert.equal(data.length, bundle.size);

  const masterBefore = git(remote, 'rev-parse', 'master');
  const outcome = await pushBundle({
    repo: 'acme/app',
    token: 'unused-for-file-remotes',
    bundle: data,
    bundleRef: 'refs/heads/feature',
    head: bundle.head,
    prerequisites: bundle.prerequisites,
    targetRef: 'refs/heads/cloud/rp-test/feature',
    force: false,
  }, `file://${path.join(root, 'github')}`);
  assert.equal(outcome, 'created');
  assert.equal(git(remote, 'rev-parse', 'cloud/rp-test/feature'), bundle.head);
  assert.equal(git(remote, 'rev-parse', 'master'), masterBefore);

  // A second push of more work fast-forwards; a rewritten branch needs --force.
  commit(sandbox, 'feature-3');
  const next = runBundle(sandbox, 'feature', xfer);
  const nextData = Buffer.concat(await Promise.all(next.parts.map((part) => fs.readFile(path.join(xfer, part)))));
  const again = { repo: 'acme/app', token: 't', bundle: nextData, bundleRef: 'refs/heads/feature', head: next.head, prerequisites: next.prerequisites, targetRef: 'refs/heads/cloud/rp-test/feature', force: false };
  assert.equal(await pushBundle(again, `file://${path.join(root, 'github')}`), 'fast-forward');

  git(sandbox, 'reset', '-q', '--hard', 'master');
  commit(sandbox, 'rewritten');
  const rewritten = runBundle(sandbox, 'feature', xfer);
  const rewrittenData = Buffer.concat(await Promise.all(rewritten.parts.map((part) => fs.readFile(path.join(xfer, part)))));
  const push = { ...again, bundle: rewrittenData, head: rewritten.head, prerequisites: rewritten.prerequisites };
  await assert.rejects(pushBundle(push, `file://${path.join(root, 'github')}`), /git push from this machine failed/u);
  assert.equal(await pushBundle({ ...push, force: true }, `file://${path.join(root, 'github')}`), 'forced');
  assert.equal(git(remote, 'rev-parse', 'cloud/rp-test/feature'), rewritten.head);
});

test('a branch with nothing new sends no bundle', async () => {
  const { root, sandbox } = await world();
  const bundle = runBundle(sandbox, 'master', path.join(root, 'xfer'));
  assert.equal(bundle.commits, 0);
  assert.deepEqual(bundle.parts, []);
  assert.deepEqual(bundle.prerequisites, []);
});

test('the bundle script fails clearly for a missing branch or directory', async () => {
  const { root, sandbox } = await world();
  for (const [dir, branch, message] of [[sandbox, 'nope', 'no such local branch'], [path.join(root, 'missing'), 'master', 'no directory']]) {
    let stdout = '';
    try {
      execFileSync('bash', ['-c', bundleScript(dir, branch, path.join(root, 'xfer'))], { encoding: 'utf8' });
    } catch (error) {
      // SAFETY: execFileSync rejects with an Error carrying the child's stdout when the script exits non-zero.
      stdout = String((error as { stdout?: string }).stdout);
    }
    assert.match(stdout, new RegExp(`RP_FAIL .*${message}`, 'u'));
  }
});
