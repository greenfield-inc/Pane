// node --test scripts/ci-gate.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EXPECTED_JOBS, SKIP_WHEN_UNCHANGED, evaluate, skipManifest, workflowJobIds } from './ci-gate.mjs';

const WORKFLOW = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8');
const ALL_JOBS = [...EXPECTED_JOBS, 'ci-result'];
const PR_SKIP = skipManifest({ event: 'pull_request', changed: { runpane: 'false', main: 'true', relay: 'false' } });

function needsWith(overrides = {}, skip = PR_SKIP) {
  const needs = Object.fromEntries(EXPECTED_JOBS.map((job) => [job, { result: 'success', outputs: {} }]));
  needs.changes.outputs.skip = JSON.stringify(skip);
  for (const [job, value] of Object.entries(overrides)) {
    if (value === undefined) delete needs[job];
    else needs[job] = { ...needs[job], ...value };
  }
  return needs;
}

test('every job succeeding passes', () => {
  const verdict = evaluate({ needs: needsWith(), workflowJobs: ALL_JOBS });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
});

test('a skip the manifest declares passes, with its reason', () => {
  const verdict = evaluate({ needs: needsWith({ 'relay-tests': { result: 'skipped' } }), workflowJobs: ALL_JOBS });
  assert.equal(verdict.ok, true);
  assert.match(verdict.rows.find((row) => row.job === 'relay-tests').reason, /no relay files changed/);
});

for (const result of ['failure', 'cancelled']) {
  test(`a ${result} job fails`, () => {
    const verdict = evaluate({ needs: needsWith({ 'markdown-links': { result } }), workflowJobs: ALL_JOBS });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.problems, [`markdown-links: ${result}.`]);
  });
}

test('a skip the manifest does not declare fails', () => {
  const verdict = evaluate({ needs: needsWith({ 'cross-os-main-tests': { result: 'skipped' } }), workflowJobs: ALL_JOBS });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /^cross-os-main-tests: was skipped/);
});

test('a skipped job that is never skippable fails', () => {
  const verdict = evaluate({ needs: needsWith({ 'quality-checks': { result: 'skipped' } }), workflowJobs: ALL_JOBS });
  assert.equal(verdict.ok, false);
});

test('a job removed from the workflow and the needs fails', () => {
  const verdict = evaluate({
    needs: needsWith({ 'typecheck-lint': undefined }),
    workflowJobs: ALL_JOBS.filter((job) => job !== 'typecheck-lint'),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('\n'), /typecheck-lint: is not in quality.yml/);
});

test('a job left out of the needs fails', () => {
  const verdict = evaluate({ needs: needsWith({ 'markdown-links': undefined }), workflowJobs: ALL_JOBS });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join('\n'), /markdown-links: is not in CI result's needs/);
});

test('a workflow job the gate does not know fails', () => {
  const verdict = evaluate({ needs: needsWith(), workflowJobs: [...ALL_JOBS, 'new-lane'] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /^new-lane: is in quality.yml but not in/);
});

test('when Detect changed areas fails, nothing may skip', () => {
  const verdict = evaluate({
    needs: needsWith({ changes: { result: 'failure', outputs: {} }, 'relay-tests': { result: 'skipped' } }),
    workflowJobs: ALL_JOBS,
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems, ['changes: failure.', 'relay-tests: was skipped, and the skip manifest gives no reason for it to skip.']);
});

test('an unreadable manifest allows no skip', () => {
  const verdict = evaluate({ needs: needsWith({ changes: { result: 'success', outputs: { skip: '' } } }), workflowJobs: ALL_JOBS });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /skip manifest is not JSON/);
});

test('pushes, merge groups and manual runs skip nothing; pull requests skip only unchanged areas', () => {
  assert.deepEqual(skipManifest({ event: 'push', changed: {} }), {});
  assert.deepEqual(skipManifest({ event: 'merge_group', changed: {} }), {});
  assert.deepEqual(skipManifest({ event: 'workflow_dispatch', changed: {} }), {});
  assert.deepEqual(Object.keys(PR_SKIP).sort(), ['relay-rust', 'relay-tests', 'runpane-wrapper-tests']);
});

// The contract with the real workflow file.
// A required check that never reports on a merge group holds the queue until
// it times out, so CI result must run on merge groups.
test('Code Quality runs on merge groups', () => {
  const on = WORKFLOW.replace(/\r\n/g, '\n').split(/^on:\n/m)[1].split(/^\S/m)[0];
  assert.match(on, /^ {2}merge_group:\n {4}types: \[ checks_requested \]$/m);
});

test('quality.yml has exactly the expected jobs plus CI result', () => {
  assert.deepEqual(workflowJobIds(WORKFLOW).sort(), [...ALL_JOBS].sort());
});

test("CI result's needs are exactly the expected jobs", () => {
  const needs = /^ {2}ci-result:\n(?: {4}.*\n)*? {4}needs: \[([^\]]*)\]/m.exec(WORKFLOW.replace(/\r\n/g, '\n'));
  assert.ok(needs, 'ci-result has a one-line needs list');
  assert.deepEqual(needs[1].split(',').map((job) => job.trim()).sort(), [...EXPECTED_JOBS].sort());
});

test('CI result runs even when jobs fail or the run is cancelled', () => {
  const block = WORKFLOW.replace(/\r\n/g, '\n').split(/^ {2}ci-result:\n/m)[1];
  assert.match(block, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
});

test('each skippable job skips only through the manifest', () => {
  const text = WORKFLOW.replace(/\r\n/g, '\n');
  for (const job of Object.keys(SKIP_WHEN_UNCHANGED)) {
    const block = text.split(new RegExp(`^ {2}${job}:\\n`, 'm'))[1].split(/^ {2}\S/m)[0];
    assert.match(block, new RegExp(`^ {4}if: \\$\\{\\{ !fromJSON\\(needs\\.changes\\.outputs\\.skip\\)\\['${job}'\\] \\}\\}$`, 'm'), job);
  }
});

// A matrix job reports one result for all its lanes, so a dropped lane would
// leave part of the wrapper suites unrun with CI result still green.
test('the wrapper lanes are package plus 1/n to n/n, with none missing', () => {
  const block = WORKFLOW.replace(/\r\n/g, '\n').split(/^ {2}runpane-wrapper-tests:\n/m)[1].split(/^ {2}\S/m)[0];
  const lanes = /^ {8}lane: \[([^\]]*)\]$/m.exec(block);
  assert.ok(lanes, 'runpane-wrapper-tests has a one-line lane list');
  const [first, ...parts] = lanes[1].split(',').map((lane) => lane.trim());
  assert.equal(first, 'package');
  assert.ok(parts.length > 0, 'at least one numbered lane');
  assert.deepEqual(parts, parts.map((_, index) => `${index + 1}/${parts.length}`));
});
