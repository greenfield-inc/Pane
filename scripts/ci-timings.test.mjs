// node --test scripts/ci-timings.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { workflowJobs } from './ci-gate.mjs';
import { checkBudgets, phaseOf } from './ci-timings.mjs';

const WORKFLOW = `name: Code Quality
jobs:
  lint:
    name: Lint (\${{ matrix.shard }}/\${{ strategy.job-total }})
    steps:
    - name: Checkout code
      uses: actions/checkout@v7
    - name: Install dependencies
      run: pnpm install
    - name: Lint
      run: pnpm lint
  ci-result:
    name: CI result
    steps:
    - name: Decide
      run: node scripts/ci-gate.mjs decide
`;

const BUDGETS = {
  targets: { waiting: 10, setup: 30, running: 60 },
  jobs: {
    lint: {
      ceilings: { setup: 50, running: 100 },
      setupSteps: ['Checkout code', 'Install dependencies'],
      steps: { Lint: { target: 5, ceiling: 10 } },
    },
  },
};

const at = (second) => new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + second * 1000).toISOString().replace('.000', '');

// One job from the jobs API: waiting, then each step back to back for its seconds.
function apiJob({ name = 'Lint (1/2)', conclusion = 'success', waiting = 3, steps = {} } = {}) {
  let clock = waiting;
  const apiSteps = Object.entries({ 'Set up job': 1, 'Checkout code': 2, 'Install dependencies': 20, Lint: 4, 'Complete job': 0, ...steps })
    .filter(([, length]) => length !== undefined)
    .map(([stepName, length]) => {
      const step = { name: stepName, conclusion: 'success', started_at: at(clock), completed_at: at(clock + length) };
      clock += length;
      return step;
    });
  return { name, conclusion, created_at: at(0), started_at: at(waiting), completed_at: at(clock), steps: apiSteps };
}

const check = (jobs, budgets = BUDGETS) => checkBudgets({ jobs, budgets, workflowText: WORKFLOW });

test('a job within its targets passes with nothing to report', () => {
  assert.deepEqual(check([apiJob()]), { ok: true, problems: [], warnings: [], unmeasured: [] });
});

test('a value at its ceiling passes and one second over fails', () => {
  const atCeiling = check([apiJob({ steps: { 'Install dependencies': 47 } })]);
  assert.equal(atCeiling.ok, true);
  assert.deepEqual(atCeiling.warnings, ['Lint (1/2) setup: 50 s is over its 30 s target (ceiling 50 s).']);

  const over = check([apiJob({ steps: { 'Install dependencies': 48 } })]);
  assert.equal(over.ok, false);
  assert.equal(over.problems.length, 1);
  assert.match(over.problems[0], /^Lint \(1\/2\) setup: 51 s is over its 50 s ceiling \(target 30 s\)\. If the run was only slow, re-run all jobs/);
});

test('each phase and budgeted step with a ceiling fails one second over it', () => {
  const verdict = check([apiJob({ waiting: 400, steps: { Lint: 11, Tests: 90 } })]);
  assert.deepEqual(verdict.warnings, ['Lint (1/2) waiting: 400 s is over its 10 s target (no ceiling).']);
  assert.deepEqual(verdict.problems.map((line) => line.split('. ')[0]), [
    'Lint (1/2) running: 101 s is over its 100 s ceiling (target 60 s)',
    'Lint (1/2) step "Lint": 11 s is over its 10 s ceiling (target 5 s)',
  ]);
});

test('a step over its target but under its ceiling only warns', () => {
  const verdict = check([apiJob({ steps: { Lint: 6 } })]);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warnings, ['Lint (1/2) step "Lint": 6 s is over its 5 s target (ceiling 10 s).']);
});

test('with enforce false, a value over its ceiling is still reported but passes', () => {
  const verdict = check([apiJob({ steps: { Lint: 11 } })], { ...BUDGETS, enforce: false });
  assert.equal(verdict.ok, true);
  assert.match(verdict.problems[0], /^Lint \(1\/2\) step "Lint": 11 s is over its 10 s ceiling/);
});

// Missing data warns: a run fails only on a measured value over its ceiling.
test('a renamed setup step is reported as not measured', () => {
  const verdict = check([apiJob({ steps: { 'Install dependencies': undefined, 'Get packages': 20 } })]);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unmeasured, ['Lint (1/2): setup step "Install dependencies" was not reported, so its setup time is incomplete.']);
});

test('a budgeted step that is missing or skipped is reported as not measured', () => {
  const missing = check([apiJob({ steps: { Lint: undefined } })]);
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.unmeasured, ['Lint (1/2): step "Lint" reported no time.']);
  const skipped = apiJob();
  skipped.steps.find((step) => step.name === 'Lint').conclusion = 'skipped';
  assert.deepEqual(check([skipped]).unmeasured, ['Lint (1/2): step "Lint" reported no time.']);
});

test('a job with no budget is reported as not measured', () => {
  const verdict = check([apiJob()], { ...BUDGETS, jobs: {} });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unmeasured, ['Lint (1/2): has no budget in scripts/ci-budgets.json.']);
});

test('failed jobs and the gate job itself are left to the gate', () => {
  const failed = apiJob({ conclusion: 'failure', steps: { Lint: 99 } });
  const gate = { ...apiJob({ name: 'CI result' }), conclusion: null, completed_at: null };
  assert.deepEqual(check([failed, gate]), { ok: true, problems: [], warnings: [], unmeasured: [] });
});

// The contract with the real files.
test('ci-budgets.json budgets every Code Quality job, with its setup steps as quality.yml names them', () => {
  const budgets = JSON.parse(readFileSync(new URL('./ci-budgets.json', import.meta.url), 'utf8'));
  const jobs = workflowJobs(readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8'))
    .filter((job) => job.id !== 'ci-result');
  assert.deepEqual(Object.keys(budgets.jobs).sort(), jobs.map((job) => job.id).sort());
  for (const job of jobs) {
    const budget = budgets.jobs[job.id];
    assert.deepEqual(budget.setupSteps, job.steps.filter((step) => phaseOf(step) === 'setup'), `${job.id} setupSteps`);
    for (const step of Object.keys(budget.steps ?? {})) assert.ok(job.steps.includes(step), `${job.id} has a step named "${step}"`);
  }
});
