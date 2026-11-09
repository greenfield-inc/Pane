#!/usr/bin/env node
// pnpm check:fast: the checks that catch most red CI runs, in a few minutes,
// before a push. It runs the type check and lint (side by side), the offline
// markdown link check, the renderer-test type check, and the unit tests that
// the branch's changes reach, in each workspace the branch changed. It does
// not run the Playwright journeys, the runpane wrapper suites or other OSes;
// CI still does. Exits non-zero when any check fails.
import { spawn, spawnSync } from 'node:child_process';

const TEST_WORKSPACES = ['main', 'frontend', 'native', 'mobile', 'glasses'];
// shared/ is imported by these, so a shared/ change runs their tests too.
const SHARED_DEPENDENTS = ['main', 'frontend'];

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(name, command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32', ...options });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ name, ok: code === 0, output, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}

function report(result) {
  if (result.output) process.stdout.write(result.output);
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.seconds}s)\n`);
  return result;
}

const base = process.env.CHECK_FAST_BASE
  ?? git(['merge-base', 'HEAD', 'origin/main'])
  ?? git(['merge-base', 'HEAD', 'main']);
if (!base) {
  console.error('check:fast could not find where this branch left main (no origin/main or main). Run `git fetch origin main`, or set CHECK_FAST_BASE=<commit>.');
  process.exit(2);
}
const changed = [
  ...(git(['diff', '--name-only', base]) ?? '').split('\n'),
  ...(git(['ls-files', '--others', '--exclude-standard']) ?? '').split('\n'),
].filter(Boolean);
const workspaces = TEST_WORKSPACES.filter((workspace) =>
  changed.some((file) => file.startsWith(`${workspace}/`))
  || (SHARED_DEPENDENTS.includes(workspace) && changed.some((file) => file.startsWith('shared/'))));

const started = Date.now();
const results = [];
console.log(`check:fast against ${base.slice(0, 12)}: ${changed.length} changed files; unit tests for ${workspaces.join(', ') || 'no workspace'}.\n`);

// Type check and lint are the slowest; they run side by side, as in CI.
results.push(...(await Promise.all([
  run('pnpm typecheck', 'pnpm', ['typecheck'], { quiet: true }),
  run('pnpm lint', 'pnpm', ['lint'], { quiet: true }),
])).map(report));

if (spawnSync('lychee', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0) {
  results.push(report(await run('markdown links (offline)', 'lychee', [
    '--offline', '--include-fragments', '--no-progress',
    '--exclude-path', 'node_modules', '--exclude-path', 'dist-electron', './**/*.md',
  ])));
} else {
  console.log('skip markdown links: lychee is not installed (brew install lychee, or cargo install lychee); CI still checks them.\n');
}

results.push(report(await run('renderer test types', 'pnpm', [
  '--filter', 'frontend', 'exec', 'tsc', '--noEmit', '-p', '../tests/renderer/tsconfig.json',
])));

for (const workspace of workspaces) {
  const result = report(await run(`${workspace} unit tests (changed since ${base.slice(0, 12)})`, 'pnpm', [
    '--filter', workspace, 'exec', 'vitest', 'run', '--changed', base, '--passWithNoTests',
  ], { quiet: true }));
  if (!result.ok && /NODE_MODULE_VERSION/.test(result.output)) {
    console.log('better-sqlite3 is built for Electron. Run `npm rebuild better-sqlite3-multiple-ciphers`, then `pnpm electron:rebuild` before starting the app again.\n');
  }
  results.push(result);
}

const failed = results.filter((result) => !result.ok);
const minutes = ((Date.now() - started) / 60000).toFixed(1);
if (failed.length > 0) {
  console.log(`check:fast failed in ${minutes} min: ${failed.map((result) => result.name).join('; ')}. Fix these before pushing; the output is above.`);
  process.exit(1);
}
console.log(`check:fast passed in ${minutes} min. CI still runs the Playwright journeys, the runpane wrapper suites and macOS and Windows.`);
