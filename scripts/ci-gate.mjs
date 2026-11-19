#!/usr/bin/env node
// The CI result gate: the one check branch protection requires.
//
//   node scripts/ci-gate.mjs decide     (in CI result) reads the jobs' results
//     from NEEDS_JSON (`toJSON(needs)`) and fails unless every expected job
//     succeeded or was skipped with a reason from the skip manifest that
//     Detect changed areas writes (scripts/ci-affected.mjs).
//
// A job that is missing (removed from the workflow or from CI result's needs),
// cancelled, failed, or skipped without a manifest reason turns CI result red.
// So does a job in quality.yml that this list does not name, so a new job is
// never silently left out of the gate.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE_JOB = 'ci-result';

// Every Code Quality job CI result waits for, by job id.
export const EXPECTED_JOBS = [
  'changes',
  'quality-checks',
  'main-tests',
  'typecheck-lint',
  'markdown-links',
  'functional-smoke-browser',
  'functional-smoke-webgl',
  'renderer-selection',
  'functional-smoke-electron',
  'runpane-wrapper-tests',
  'cross-os-main-tests',
  'relay-rust',
  'relay-tests',
  'pwa-build',
];

/**
 * Top-level jobs in a workflow file, read without a YAML parser: each job's
 * id, its `name:` (the id when it has none) and its step names, in order.
 */
export function workflowJobs(workflowText) {
  const jobs = [];
  let inJobs = false;
  for (const line of workflowText.split(/\r?\n/)) {
    if (/^jobs:\s*(#.*)?$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    const id = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (id) { jobs.push({ id: id[1], name: id[1], steps: [] }); continue; }
    const job = jobs.at(-1);
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (job && name) job.name = unquote(name[1]);
    const step = /^ {4}- name:\s*(.+?)\s*$/.exec(line);
    if (job && step) job.steps.push(unquote(step[1]));
  }
  return jobs;
}

const unquote = (value) => value.replace(/^(['"])(.*)\1$/, '$2');

/** Top-level job ids in a workflow file. */
export function workflowJobIds(workflowText) {
  return workflowJobs(workflowText).map((job) => job.id);
}

/**
 * The gate's verdict. `needs` is `toJSON(needs)` from CI result; `workflowJobs`
 * the job ids in quality.yml. Returns one row per job and the problems found.
 */
export function evaluate({ needs, workflowJobs }) {
  const problems = [];
  const rows = [];

  let skip = {};
  const rawSkip = needs.changes?.outputs?.skip;
  if (needs.changes?.result === 'success') {
    try {
      skip = JSON.parse(rawSkip ?? '');
    } catch {
      problems.push(`changes: its skip manifest is not JSON (${JSON.stringify(rawSkip ?? null)}), so no skip can be allowed.`);
    }
  }
  for (const job of Object.keys(skip)) {
    if (!EXPECTED_JOBS.includes(job)) problems.push(`${job}: the skip manifest names a job CI result does not expect.`);
  }

  for (const job of workflowJobs) {
    if (job !== GATE_JOB && !EXPECTED_JOBS.includes(job)) {
      problems.push(`${job}: is in quality.yml but not in scripts/ci-gate.mjs EXPECTED_JOBS, so CI result would not check it. Add it there and to CI result's needs.`);
    }
  }
  for (const job of Object.keys(needs)) {
    if (!EXPECTED_JOBS.includes(job)) {
      problems.push(`${job}: is in CI result's needs but not in scripts/ci-gate.mjs EXPECTED_JOBS.`);
    }
  }

  for (const job of EXPECTED_JOBS) {
    if (!workflowJobs.includes(job)) {
      rows.push({ job, result: 'missing', verdict: 'fail' });
      problems.push(`${job}: is not in quality.yml. A removed job fails CI result; remove it from EXPECTED_JOBS in the same change if that is intended.`);
      continue;
    }
    const entry = needs[job];
    if (!entry) {
      rows.push({ job, result: 'missing', verdict: 'fail' });
      problems.push(`${job}: is not in CI result's needs, so its result is unknown.`);
      continue;
    }
    const { result } = entry;
    if (result === 'success') {
      rows.push({ job, result, verdict: 'pass' });
    } else if (result === 'skipped' && skip[job]) {
      rows.push({ job, result, verdict: 'pass', reason: skip[job] });
    } else if (result === 'skipped') {
      rows.push({ job, result, verdict: 'fail' });
      problems.push(`${job}: was skipped, and the skip manifest gives no reason for it to skip.`);
    } else {
      rows.push({ job, result, verdict: 'fail' });
      problems.push(`${job}: ${result}.`);
    }
  }
  return { ok: problems.length === 0, rows, problems };
}

function summaryMarkdown({ ok, rows, problems }) {
  const lines = [
    `### CI result: ${ok ? 'pass' : 'fail'}`,
    '',
    '| Job | Result | Verdict | Reason |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.job} | ${row.result} | ${row.verdict} | ${row.reason ?? ''} |`),
  ];
  if (problems.length > 0) lines.push('', ...problems.map((problem) => `- ${problem}`));
  return `${lines.join('\n')}\n`;
}

function main() {
  const [command] = process.argv.slice(2);
  if (command === 'decide') {
    if (!process.env.NEEDS_JSON) throw new Error('NEEDS_JSON is not set. CI result passes it as `toJSON(needs)`.');
    const workflowPath = new URL('../.github/workflows/quality.yml', import.meta.url);
    const verdict = evaluate({
      needs: JSON.parse(process.env.NEEDS_JSON),
      workflowJobs: workflowJobIds(readFileSync(workflowPath, 'utf8')),
    });
    const markdown = summaryMarkdown(verdict);
    process.stdout.write(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    for (const problem of verdict.problems) console.log(`::error title=CI result::${problem}`);
    process.exitCode = verdict.ok ? 0 : 1;
    return;
  }
  throw new Error(`Unknown command ${command ?? '(none)'}. Use \`decide\`.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
