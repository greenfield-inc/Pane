#!/usr/bin/env node
// Every test file in the repo and the CI lane that runs it.
//
//   node scripts/ci-test-inventory.mjs check   fails when a tracked test file runs
//     in no lane and is not in NOT_IN_CI, or when a lane or NOT_IN_CI entry
//     no longer matches the workflows. Type Check and Lint runs it.
//   node scripts/ci-test-inventory.mjs list    prints every test file with its lanes.
//
// A lane is a command in a workflow job. Its files come from the runner itself
// (`vitest list`, `playwright test --list`) or are named in the job's steps,
// so the inventory sees what CI runs, not what a config was meant to run.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Tracked files that are tests. Helpers and fixtures do not match. */
export const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^tests\/renderer\/[^/]+\.renderer\.ts$/,
  /^scripts\/test-[^/]+\.(js|cjs|mjs|sh|py)$/,
  /^(relay|direct)\/tests\/[^/]+\.rs$/,
  /\/src\/(test|androidTest)\/.+\.(java|kt)$/,
];

// Each lane: the workflow and job that run it, the text in that job's steps
// (after expanding `pnpm <script>` from package.json) that runs it, and how to
// list its files.
const NATIVE_GLASSES_MOBILE = 'pnpm --filter native --filter glasses --filter mobile run test';

// A lane with `stabilizing` runs and reports, but CI result does not wait for it; the value is why.
const STABILIZING = 'stabilizing: tab-popover.spec.ts:85 failed once in CI (run 44485044464) and passed 200 of 200 on parsa-devbox, cause not yet known; returns to the required lane once it is found';

export const LANES = [
  { workflow: 'quality.yml', job: 'quality-checks', run: 'pnpm --filter frontend exec vitest run', list: { vitest: 'frontend' } },
  { workflow: 'quality.yml', job: 'quality-checks', run: NATIVE_GLASSES_MOBILE, list: { vitest: 'native' } },
  { workflow: 'quality.yml', job: 'quality-checks', run: NATIVE_GLASSES_MOBILE, list: { vitest: 'glasses' } },
  { workflow: 'quality.yml', job: 'quality-checks', run: NATIVE_GLASSES_MOBILE, list: { vitest: 'mobile' } },
  { workflow: 'quality.yml', job: 'quality-checks', list: { named: [
    'scripts/test-publish-github-release.sh',
    'scripts/test-merge-mac-latest.js',
    'scripts/test-license-generation.js',
    'scripts/flapping-link-proxy.test.mjs',
    'scripts/patch-electron-builder-macos-keychain.test.js',
  ] } },
  { workflow: 'quality.yml', job: 'main-tests', run: 'pnpm --filter main exec vitest run --shard', list: { vitest: 'main' } },
  { workflow: 'quality.yml', job: 'cross-os-main-tests', run: 'pnpm --filter main exec vitest run --shard', list: { vitest: 'main' } },
  { workflow: 'quality.yml', job: 'typecheck-lint', list: { named: ['scripts/ci-gate.test.mjs', 'scripts/ci-timings.test.mjs', 'scripts/pre-push.test.mjs', 'scripts/ci-test-inventory.test.mjs'] } },
  { workflow: 'quality.yml', job: 'functional-smoke-browser', run: 'playwright test --config=playwright.ci.minimal.config.ts', list: { playwright: 'playwright.ci.minimal.config.ts' } },
  { workflow: 'quality.yml', job: 'functional-smoke-stabilizing', run: 'playwright test --config=playwright.ci.stabilizing.config.ts', list: { playwright: 'playwright.ci.stabilizing.config.ts' }, stabilizing: STABILIZING },
  { workflow: 'quality.yml', job: 'functional-smoke-webgl', run: 'playwright test --config=playwright.ci.webgl.config.ts', list: { playwright: 'playwright.ci.webgl.config.ts' } },
  { workflow: 'quality.yml', job: 'renderer-selection', run: 'playwright test --config=tests/renderer/playwright.config.ts', list: { playwright: 'tests/renderer/playwright.config.ts' } },
  { workflow: 'quality.yml', job: 'functional-smoke-electron', run: 'playwright test --config=playwright.chat-tabs.config.ts', list: { playwright: 'playwright.chat-tabs.config.ts' } },
  { workflow: 'quality.yml', job: 'functional-smoke-electron', run: 'playwright test --config=playwright.ci.stabilizing-electron.config.ts', list: { playwright: 'playwright.ci.stabilizing-electron.config.ts' }, stabilizing: 'stabilizing: todos-upgrade.spec.ts (R21, added by #1481) hung past its 180 s timeout once on main (run 44596759187) after passing 10 of 10 in probe #1610, cause not yet known; returns to the required Electron specs once it is found' },
  { workflow: 'quality.yml', job: 'functional-smoke-electron', list: { named: ['scripts/test-worktree-trash-electron.cjs'] } },
  { workflow: 'quality.yml', job: 'runpane-wrapper-tests', list: { named: [
    'scripts/test-runpane-package-smoke.js',
    'scripts/test-runpane-contract.js',
    'scripts/test-runpane-handoff.js',
    'scripts/test-runpane-mcp.js',
    'scripts/test-runpane-node-runtime.js',
    'scripts/test-runpane-ask.js',
    'scripts/test-runpane-workspace.js',
    'scripts/test-runpane-managed-cli.js',
    'scripts/test-runpane-telemetry.js',
    'scripts/test-runpane-submit.js',
  ] } },
  // test-runpane-contract.js runs these itself.
  { workflow: 'quality.yml', job: 'runpane-wrapper-tests', via: 'scripts/test-runpane-contract.js', list: { named: [
    'scripts/test-runpane-dispatch.js',
    'scripts/test-runpane-python-parity.js',
    'scripts/test-runpane-setup-pty.py',
    'scripts/test-runpane-todo-times.js',
    'scripts/test-runpane-watch-defaults.js',
  ] } },
  { workflow: 'quality.yml', job: 'relay-rust', run: 'cargo test --locked', list: { glob: /^(relay|direct)\/tests\/[^/]+\.rs$/ } },
  { workflow: 'quality.yml', job: 'relay-tests', list: { named: ['scripts/test-runpane-relay.js'] } },
  // Tests of the packaged app run in Linux Package Build, on pull requests that touch
  // packaging. That workflow is not part of CI result, so a pull request that touches
  // no packaging path can break them and still merge green.
  { workflow: 'linux-package-build.yml', job: 'build', list: { named: ['scripts/test-packaged-native-architecture.js', 'scripts/test-packaged-headless-remote-setup.sh'] } },
];

// Test files that run in no CI lane, each with its reason. A lane may still
// list one that skips itself there (session-activity-real.spec.ts).
export const NOT_IN_CI = {
  'tests/anim-evidence.spec.ts': 'Records before/after animation videos for a PR (pnpm anim:evidence); a capture rig, not a check.',
  'tests/anim-evidence-remote.spec.ts': 'Records the remote PWA animation videos for a PR (pnpm anim:evidence:remote); a capture rig, not a check.',
  'tests/panel-status-render-perf.spec.ts': 'Render-count measurement; needs PANE_REACT_SCAN=1 on the runner and the dev server.',
  'tests/session-output-perf.spec.ts': 'Render-count measurement; needs PANE_REACT_SCAN=1 on the runner and the dev server.',
  'tests/terminal-frames.perf.spec.ts': '120 Hz frame harness; needs PANE_FRAME_HARNESS=1 and a running dev server, and measures rather than checks.',
  'tests/session-activity-real.spec.ts': 'Spends real Claude Code and Codex model turns; runs only by hand with SESSION_ACTIVITY_REAL=1.',
  'tests/orchestration-sessions.known-bug.spec.ts': 'Fails on product bug #1560 (closing an unfocused Session tile only focuses it); back in CI once fixed.',
  'tests/remote-pwa-browser.known-bug.spec.ts': 'Fails on product bug #1559 (the phone never gets a port address asked for during restore); back in CI once fixed.',
  'tests/review-availability.known-bug.spec.ts': 'Fails on product bug #1562 (Add tool labels cut twice off macOS); back in CI once fixed.',
  'tests/command-palette.speed.spec.ts': 'Speed budgets (16 ms ranking, 100 ms repaint) that a 4-vCPU CI runner misses; run by hand.',
  'mobile/android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java': 'Capacitor template placeholder (asserts 2 + 2 = 4); proposed for removal.',
  'mobile/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java': 'Capacitor template placeholder (checks the package name on a device); proposed for removal.',
};

/** A job's text in a workflow, with every `pnpm [run] <script>` it calls expanded once. */
export function jobText(workflowText, job, packageScripts = {}) {
  const text = workflowText.replace(/\r\n/g, '\n');
  const parts = text.split(new RegExp(`^ {2}${job}:\\n`, 'm'));
  if (parts.length < 2) return null;
  const block = parts[1].split(/^ {2}\S/m)[0];
  const expanded = [block];
  for (const match of block.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)) {
    if (packageScripts[match[1]]) expanded.push(packageScripts[match[1]]);
  }
  return expanded.join('\n');
}

/**
 * The verdict. `testFiles` are the tracked test files; `lanes` the LANES with
 * `files` filled in; `jobTexts` maps `<workflow>#<job>` to jobText (null when
 * the job is missing); `readFile` reads a repo file for `via` lanes.
 */
export function evaluate({ testFiles, lanes, jobTexts, readFile, notInCi = NOT_IN_CI }) {
  const problems = [];
  const lanesByFile = new Map(testFiles.map((file) => [file, []]));
  for (const lane of lanes) {
    const name = `${lane.workflow}#${lane.job}`;
    const text = jobTexts[name];
    if (text == null) {
      problems.push(`${name}: no such job, so its lane runs nothing. Update LANES in scripts/ci-test-inventory.mjs.`);
      continue;
    }
    if (lane.run && !text.includes(lane.run)) {
      problems.push(`${name}: no step runs \`${lane.run}\`. Update LANES in scripts/ci-test-inventory.mjs.`);
      continue;
    }
    const caller = lane.via ? readFile(lane.via) : text;
    if (lane.via && !text.includes(lane.via)) problems.push(`${name}: no step runs ${lane.via}.`);
    for (const file of lane.files) {
      if (lane.list.named && !caller.includes(lane.via ? path.posix.basename(file) : file)) {
        problems.push(`${file}: LANES says ${name} runs it, but ${lane.via ?? 'no step there'} names it.`);
        continue;
      }
      if (!lanesByFile.has(file)) {
        if (lane.list.named) problems.push(`${file}: is in LANES but is not a tracked test file.`);
        continue;
      }
      lanesByFile.get(file).push(lane.stabilizing ? `${name} (stabilizing)` : name);
    }
  }
  for (const file of Object.keys(notInCi)) {
    if (!lanesByFile.has(file)) problems.push(`${file}: is in NOT_IN_CI but is not a tracked test file. Remove it from NOT_IN_CI.`);
  }
  const unmapped = [...lanesByFile].filter(([file, fileLanes]) => fileLanes.length === 0 && !notInCi[file]).map(([file]) => file);
  for (const file of unmapped) {
    problems.push(`${file}: runs in no CI lane. Add it to a CI config (for a Playwright spec, playwright.ci.minimal.config.ts or playwright.chat-tabs.config.ts) or to NOT_IN_CI in scripts/ci-test-inventory.mjs with the reason it never runs in CI.`);
  }
  return { ok: problems.length === 0, lanesByFile, problems };
}

function sh(command, args, cwd = ROOT) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
}

function vitestFiles(dir) {
  const listed = JSON.parse(sh('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json'], path.join(ROOT, dir)));
  return listed.map((entry) => path.relative(ROOT, entry.file).split(path.sep).join('/'));
}

function playwrightFiles(config) {
  const report = JSON.parse(sh('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json', `--config=${config}`]));
  const configDir = path.resolve(ROOT, report.config.rootDir ?? path.dirname(config));
  const files = new Set();
  const walk = (suite) => {
    if (suite.file && (suite.specs ?? []).length > 0) files.add(path.relative(ROOT, path.resolve(configDir, suite.file)).split(path.sep).join('/'));
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return [...files];
}

function resolveLanes(trackedFiles) {
  return LANES.map((lane) => {
    const { list } = lane;
    let files;
    if (list.vitest) files = vitestFiles(list.vitest);
    else if (list.playwright) files = playwrightFiles(list.playwright);
    else if (list.glob) files = trackedFiles.filter((file) => list.glob.test(file));
    else files = list.named;
    return { ...lane, files };
  });
}

function main() {
  const [command] = process.argv.slice(2);
  if (command !== 'check' && command !== 'list') throw new Error(`Unknown command ${command ?? '(none)'}. Use \`check\` or \`list\`.`);
  const tracked = sh('git', ['ls-files', '-z']).split('\0').filter(Boolean);
  const testFiles = tracked.filter((file) => TEST_FILE_PATTERNS.some((pattern) => pattern.test(file)));
  const packageScripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const jobTexts = {};
  for (const { workflow, job } of LANES) {
    const file = path.join(ROOT, '.github/workflows', workflow);
    jobTexts[`${workflow}#${job}`] = existsSync(file) ? jobText(readFileSync(file, 'utf8'), job, packageScripts) : null;
  }
  const verdict = evaluate({
    testFiles,
    lanes: resolveLanes(tracked),
    jobTexts,
    readFile: (file) => readFileSync(path.join(ROOT, file), 'utf8'),
  });

  if (command === 'list') {
    for (const [file, fileLanes] of verdict.lanesByFile) {
      console.log(`${file}\t${fileLanes.length > 0 ? [...new Set(fileLanes)].join(', ') : `NOT IN CI: ${NOT_IN_CI[file] ?? 'unmapped'}`}`);
    }
  }
  const perLane = new Map();
  for (const fileLanes of verdict.lanesByFile.values()) for (const lane of new Set(fileLanes)) perLane.set(lane, (perLane.get(lane) ?? 0) + 1);
  const notInCi = Object.keys(NOT_IN_CI).filter((file) => verdict.lanesByFile.has(file)).length;
  // Code Quality is the workflow CI result gates; lanes elsewhere run outside it.
  // A stabilizing lane reports there but CI result does not wait for it.
  const gated = (lane) => lane.startsWith('quality.yml#') && !lane.endsWith(' (stabilizing)');
  const ungated = [...verdict.lanesByFile].filter(([, fileLanes]) => fileLanes.length > 0 && !fileLanes.some(gated)).map(([file]) => file);
  const summary = [
    `### Test inventory: ${verdict.ok ? 'every test file has a lane' : 'fail'}`,
    '',
    `${verdict.lanesByFile.size} test files; ${notInCi} listed as not in CI with a reason.`,
    '',
    '| Lane | Files |',
    '| --- | --- |',
    ...[...perLane].map(([lane, count]) => `| ${lane}${gated(lane) || lane.endsWith(' (stabilizing)') ? '' : ' (not part of CI result)'} | ${count} |`),
    ...(LANES.some((lane) => lane.stabilizing) ? ['', 'Lanes marked (stabilizing) report, but CI result does not wait for them:', ...LANES.filter((lane) => lane.stabilizing).map((lane) => `- ${lane.job}: ${lane.stabilizing}.`)] : []),
    ...(ungated.length > 0 ? ['', `Run only outside CI result: ${ungated.join(', ')}.`] : []),
    ...(verdict.problems.length > 0 ? ['', ...verdict.problems.map((problem) => `- ${problem}`)] : []),
    '',
  ].join('\n');
  if (command === 'check') process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  for (const problem of verdict.problems) console.log(`::error title=Test inventory::${problem}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
