// node scripts/benchmark-git-worktree-config.mjs
// Times the git commands behind Pane's status refresh and Diff tab in a large
// synthetic repository: with default git config, with the config Pane writes
// when it opens a repository (see main/src/services/gitPerformanceConfig.ts),
// and with that config plus GIT_OPTIONAL_LOCKS=0 on every command.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fileCount = Number(process.env.FILES ?? 100_000);
const runs = Number(process.env.RUNS ?? 10);
const filesPerDir = 100;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-git-config-bench-'));

let commandEnv = process.env;

async function git(cwd, args, okExitCodes = []) {
  try {
    return (await run('git', args, { cwd, env: commandEnv, maxBuffer: 256 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (okExitCodes.includes(error.code)) return error.stdout;
    throw error;
  }
}

async function timed(task) {
  const started = performance.now();
  await task();
  return performance.now() - started;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(1));
}

async function createRepository(name, config) {
  const repo = path.join(root, name, 'repo');
  for (let index = 0; index < fileCount; index++) {
    const dir = path.join(repo, `dir-${Math.floor(index / filesPerDir)}`);
    if (index % filesPerDir === 0) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `file-${index % filesPerDir}.txt`), `line ${index}\n`);
  }
  await git(repo, ['init', '-q', '-b', 'main']);
  for (const [key, value] of Object.entries(config)) await git(repo, ['config', key, value]);
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.test', 'commit', '-qm', 'base']);
  const worktree = path.join(root, name, 'worktree');
  await git(repo, ['worktree', 'add', '-q', '-b', 'session', worktree, 'main']);
  return { repo, worktree };
}

// gitPlumbingCommands.fastCheckWorkingDirectory, run on every status refresh.
async function statusRefresh(cwd) {
  await git(cwd, ['update-index', '--refresh', '--ignore-submodules'], [1]);
  await git(cwd, ['diff-files', '--quiet', '--ignore-submodules'], [1]);
  await git(cwd, ['diff-index', '--cached', '--quiet', 'HEAD', '--ignore-submodules'], [1]);
  await git(cwd, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory']);
  await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
}

// GitDiffManager.getDiffManifest for the working tree, which Pane runs in parallel.
async function diffManifest(cwd) {
  await Promise.all([
    git(cwd, ['diff', '-z', '-M', '--name-status', 'main', '--']),
    git(cwd, ['diff', '-z', '-M', '--numstat', 'main', '--']),
    git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']),
    git(cwd, ['ls-files', '-z', '--unmerged']),
  ]);
}

async function measure(name, config, env = {}) {
  const { repo, worktree } = await createRepository(name, config);
  commandEnv = { ...process.env, ...env };
  await statusRefresh(worktree);
  await diffManifest(worktree);
  await git(worktree, ['status', '--porcelain']);
  const results = { statusRefresh: [], diffTab: [], gitStatus: [] };
  for (let index = 0; index < runs; index++) {
    // An agent edit: one tracked file changes and one new file appears.
    fs.appendFileSync(path.join(worktree, `dir-${index}`, 'file-0.txt'), 'edit\n');
    fs.writeFileSync(path.join(worktree, `dir-${index}`, `new-${index}.txt`), 'new\n');
    results.statusRefresh.push(await timed(() => statusRefresh(worktree)));
    results.diffTab.push(await timed(() => diffManifest(worktree)));
    results.gitStatus.push(await timed(() => git(worktree, ['status', '--porcelain'])));
  }
  commandEnv = process.env;
  for (const cwd of [worktree, repo]) await git(cwd, ['fsmonitor--daemon', 'stop']).catch(() => {});
  return Object.fromEntries(Object.entries(results).map(([key, values]) => [key, median(values)]));
}

try {
  const buildOptions = await git(root, ['version', '--build-options']);
  const fastConfig = { 'feature.manyFiles': 'true' };
  if (buildOptions.includes('fsmonitor--daemon')) fastConfig['core.fsmonitor'] = 'true';
  const before = await measure('default', {});
  const after = await measure('fast', fastConfig);
  const afterWithoutOptionalLocks = await measure('fast-no-optional-locks', fastConfig, { GIT_OPTIONAL_LOCKS: '0' });
  console.log(JSON.stringify({
    os: `${os.platform()} ${os.release()}`,
    git: buildOptions.split('\n')[0],
    files: fileCount,
    runs,
    fastConfig,
    medianMs: { before, after, afterWithoutOptionalLocks },
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
