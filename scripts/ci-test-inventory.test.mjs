// node --test scripts/ci-test-inventory.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluate, jobText } from './ci-test-inventory.mjs';

const WORKFLOW = `jobs:
  unit:
    steps:
    - run: pnpm --filter app exec vitest run
    - run: node --test scripts/test-a.js
  e2e:
    steps:
    - run: pnpm test:e2e --shard=1/2
`;
const SCRIPTS = { 'test:e2e': 'playwright test --config=e2e.config.ts' };
const JOBS = { 'ci.yml#unit': jobText(WORKFLOW, 'unit', SCRIPTS), 'ci.yml#e2e': jobText(WORKFLOW, 'e2e', SCRIPTS) };
const LANES = [
  { workflow: 'ci.yml', job: 'unit', run: 'pnpm --filter app exec vitest run', list: { vitest: 'app' }, files: ['app/a.test.ts'] },
  { workflow: 'ci.yml', job: 'unit', list: { named: ['scripts/test-a.js'] }, files: ['scripts/test-a.js'] },
  { workflow: 'ci.yml', job: 'e2e', run: 'playwright test --config=e2e.config.ts', list: { playwright: 'e2e.config.ts' }, files: ['tests/one.spec.ts'] },
];
const FILES = ['app/a.test.ts', 'scripts/test-a.js', 'tests/one.spec.ts'];
const run = (overrides) => evaluate({ testFiles: FILES, lanes: LANES, jobTexts: JOBS, readFile: () => '', notInCi: {}, ...overrides });

test('every file in a lane passes, with the lanes that run it', () => {
  const verdict = run();
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.lanesByFile.get('tests/one.spec.ts'), ['ci.yml#e2e']);
});

test('a new spec no lane lists fails until it is mapped', () => {
  const verdict = run({ testFiles: [...FILES, 'tests/new.spec.ts'] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('\n'), /^tests\/new\.spec\.ts: runs in no CI lane/m);
  assert.equal(run({ testFiles: [...FILES, 'tests/new.spec.ts'], notInCi: { 'tests/new.spec.ts': 'capture rig' } }).ok, true);
});

test('a NOT_IN_CI entry for a file that is gone fails', () => {
  assert.match(run({ notInCi: { 'tests/gone.spec.ts': 'old' } }).problems[0], /^tests\/gone\.spec\.ts: is in NOT_IN_CI but is not a tracked/);
});

test('a lane whose command left the job runs nothing and fails', () => {
  const jobTexts = { ...JOBS, 'ci.yml#e2e': jobText(WORKFLOW.replace('pnpm test:e2e', 'pnpm lint'), 'e2e', SCRIPTS) };
  const verdict = run({ jobTexts });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('\n'), /ci\.yml#e2e: no step runs `playwright test --config=e2e\.config\.ts`/);
  assert.match(verdict.problems.join('\n'), /tests\/one\.spec\.ts: runs in no CI lane/);
});

test('a named file the job no longer runs fails', () => {
  const jobTexts = { ...JOBS, 'ci.yml#unit': jobText(WORKFLOW.replace(' scripts/test-a.js', ''), 'unit', SCRIPTS) };
  assert.match(run({ jobTexts }).problems.join('\n'), /scripts\/test-a\.js: LANES says ci\.yml#unit runs it/);
});

test('a missing job fails', () => {
  assert.match(run({ jobTexts: { ...JOBS, 'ci.yml#e2e': null } }).problems[0], /^ci\.yml#e2e: no such job/);
});
