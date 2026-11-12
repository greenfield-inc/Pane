#!/usr/bin/env node
// Writes ci-timings.json: one row per successful run of each CI, release and
// deploy workflow, with its wall time, for charting CI speed over time.
//
//   node scripts/ci-timings.mjs --since 2026-10-10 --until 2026-11-10T09:00:00Z
//     [--out ci-timings.json] [--workflow quality.yml]... [--cache <dir>]
//
// Wall time is the first job's start to the last job's end in attempt 1. A run
// whose attempt 1 did not succeed is left out, because a re-run keeps the
// earlier attempt's jobs and would stretch the wall time. Reads the GitHub API
// through `gh api`, so it needs `gh auth login`, and caches each run's jobs in
// --cache so a second run makes only the listing calls.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = 'greenfield-inc/Pane';

const WORKFLOWS = {
  'build.yml': 'Build & Release',
  'nightly-release.yml': 'Nightly / Canary Release',
  'quality.yml': 'Code Quality',
  'native-android.yml': 'Native Android Build',
  'windows-arm64-build.yml': 'Windows ARM64 Build',
  'notes-native-qa.yml': 'Notes Native QA',
  'linux-package-build.yml': 'Linux Package Build',
  'deploy-remote-pwa-preview.yml': 'Deploy Remote PWA Preview',
};

// The CI speed PRs. `branches` are the branches whose runs carry the PR's
// changes: its own branch, the branches stacked on it, and its bench branches.
const SPEED_PRS = [
  { pr: 1282, label: 'Android APK only for native changes; Vite-only smoke; Electron fetched once',
    workflows: ['Code Quality', 'Native Android Build'],
    branches: ['ci-speed-p1', 'ci-speed-rest', 'ci-speed-gate'] },
  { pr: 1286, label: 'Flaky test fixes with one reported retry',
    workflows: ['Code Quality'],
    branches: ['ci-speed-rest', 'ci-speed-gate'] },
  { pr: 1291, label: 'One publish job; per-arch macOS release jobs; package workflows install once',
    workflows: ['Build & Release', 'Nightly / Canary Release', 'Windows ARM64 Build', 'Notes Native QA', 'Linux Package Build', 'Deploy Remote PWA Preview'],
    branches: ['ci-speed-release'], unsignedDryRuns: true },
];

// Dry runs with sign=false neither sign nor notarize. projected_wall_seconds adds what v2.4.216
// spent on it: 214 s (arm64) and 219 s (x64) from package to notarized, less
// the same unsigned span in the 2026-10-31 nightly (46 s, 17 s). With one job
// per macOS arch the two run side by side, so only the slower one counts.
const SIGNING_SECONDS = { perArchJobs: 202, oneMacJob: 370 };

function parseArgs(argv) {
  const args = { workflows: [], out: 'ci-timings.json', cache: path.join(os.tmpdir(), 'ci-timings-cache') };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--since') args.since = value;
    else if (flag === '--until') args.until = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--cache') args.cache = value;
    else if (flag === '--workflow') args.workflows.push(value);
    else throw new Error(`Unknown option ${flag}. Options: --since, --until, --out, --workflow, --cache.`);
    i += 1;
  }
  if (!args.since || !args.until) {
    throw new Error('--since and --until are required, for example --since 2026-10-10 --until 2026-11-10T09:00:00Z, so a re-run returns the same rows.');
  }
  for (const file of args.workflows) {
    if (!WORKFLOWS[file]) throw new Error(`${file} is not in scope. Use one of: ${Object.keys(WORKFLOWS).join(', ')}.`);
  }
  if (args.workflows.length === 0) args.workflows = Object.keys(WORKFLOWS);
  return args;
}

// GitHub answers 502/503/504 now and then; those are retried twice.
async function gh(apiPath, attempt = 1) {
  try {
    const { stdout } = await run('gh', ['api', apiPath], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    if (attempt < 3 && /HTTP 50[234]/.test(detail)) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
      return gh(apiPath, attempt + 1);
    }
    throw new Error(`gh api ${apiPath} failed: ${detail}. If this is a rate limit, wait for the reset shown by \`gh api rate_limit\` and run again; cached runs are not fetched twice.`);
  }
}

async function cached(cacheDir, key, load) {
  const file = path.join(cacheDir, `${key}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    const value = await load();
    await writeFile(file, JSON.stringify(value));
    return value;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

// The runs API returns at most 1,000 runs per query, so the window is listed
// a week at a time, and a week that still hits the cap is reported.
const WEEK_MS = 7 * 24 * 3600 * 1000;
const API_CAP = 1000;

async function listRuns(file, since, until) {
  const runs = [];
  const end = Date.parse(until);
  for (let from = Date.parse(since); from < end; from += WEEK_MS) {
    const window = `${new Date(from).toISOString()}..${new Date(Math.min(from + WEEK_MS, end)).toISOString()}`;
    for (let page = 1; ; page += 1) {
      const body = await gh(`repos/${REPO}/actions/workflows/${file}/runs?status=success&created=${window}&per_page=100&page=${page}`);
      if (page === 1 && body.total_count > API_CAP) {
        console.error(`Warning: ${file} has ${body.total_count} successful runs in ${window}; the API returns only ${API_CAP}, so some are missing. Narrow --since/--until.`);
      }
      runs.push(...body.workflow_runs);
      if (body.workflow_runs.length < 100 || page * 100 >= API_CAP) break;
    }
  }
  // A run created on a window's edge appears in both windows.
  return [...new Map(runs.map((run) => [run.id, run])).values()];
}

// Attempt 1's jobs, or null when attempt 1 did not succeed.
async function firstAttemptJobs(cacheDir, workflowRun) {
  return cached(cacheDir, `run-${workflowRun.id}-a1`, async () => {
    if (workflowRun.run_attempt > 1) {
      const attempt = await gh(`repos/${REPO}/actions/runs/${workflowRun.id}/attempts/1`);
      if (attempt.conclusion !== 'success') return null;
    }
    const jobs = [];
    for (let page = 1; ; page += 1) {
      const body = await gh(`repos/${REPO}/actions/runs/${workflowRun.id}/attempts/1/jobs?per_page=100&page=${page}`);
      jobs.push(...body.jobs.map(({ name, conclusion, created_at, started_at, completed_at }) => ({ name, conclusion, created_at, started_at, completed_at })));
      if (body.jobs.length < 100) return jobs;
    }
  });
}

const seconds = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

function kindOf(file, workflowRun, jobs) {
  const ran = (name) => jobs.some((job) => job.name === name && job.conclusion !== 'skipped');
  if (file === 'build.yml') {
    if (workflowRun.event === 'push' && /^v\d/.test(workflowRun.head_branch)) return 'release';
    return ran('publish-npm') ? 'release' : 'dry-run';
  }
  if (file === 'nightly-release.yml') return ran('publish') ? 'release' : 'dry-run';
  const onSpeedBranch = SPEED_PRS.some((pr) => pr.branches.includes(workflowRun.head_branch));
  if (workflowRun.head_branch.startsWith('bench/') || (onSpeedBranch && workflowRun.event === 'workflow_dispatch')) return 'bench';
  return 'ci';
}

function annotationsFor(workflowRun, prs) {
  const onMain = workflowRun.head_branch === 'main' || /^v\d/.test(workflowRun.head_branch);
  return prs
    .filter((pr) => (onMain
      ? pr.merged_at && pr.merged_at <= workflowRun.created_at
      : pr.branches.some((branch) => workflowRun.head_branch === branch || workflowRun.head_branch.startsWith(`bench/${branch}`))))
    .map((pr) => pr.pr);
}

function rowFor(file, workflowRun, jobs, prs) {
  const ran = jobs.filter((job) => job.conclusion !== 'skipped' && job.started_at && job.completed_at);
  if (ran.length === 0) return null;
  const start = ran.reduce((min, job) => (job.started_at < min ? job.started_at : min), ran[0].started_at);
  const last = ran.reduce((max, job) => (job.completed_at > max.completed_at ? job : max), ran[0]);
  const kind = kindOf(file, workflowRun, jobs);
  const row = {
    workflow: WORKFLOWS[file],
    workflow_file: file,
    run_id: workflowRun.id,
    date: workflowRun.created_at,
    wall_seconds: seconds(start, last.completed_at),
    head_sha: workflowRun.head_sha,
    event: workflowRun.event,
    branch: workflowRun.head_branch,
    kind,
    critical_job: last.name,
    queue_seconds_max: Math.max(...ran.map((job) => seconds(job.created_at, job.started_at))),
    annotations: annotationsFor(workflowRun, prs),
  };
  // A dry run is unsigned when its run name says sign=false (build.yml's
  // run-name), or when it ran on a branch that dry-ran with sign=false before
  // the run name said so. Other dry runs signed, so their wall time includes it.
  const unsigned = /\bsign=false\b/.test(workflowRun.display_title ?? '')
    || prs.some((pr) => pr.unsignedDryRuns && pr.branches.some((branch) => workflowRun.head_branch === branch || workflowRun.head_branch.startsWith(`bench/${branch}`)));
  if (kind === 'dry-run' && file === 'build.yml' && unsigned) {
    const macJobs = ran.filter((job) => /macos/i.test(job.name) && job.name.startsWith('build'));
    row.projected_wall_seconds = row.wall_seconds + (macJobs.length > 1 ? SIGNING_SECONDS.perArchJobs : SIGNING_SECONDS.oneMacJob);
  }
  return row;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.cache, { recursive: true });

  const prs = await mapLimit(SPEED_PRS, 3, async (entry) => {
    const pr = await gh(`repos/${REPO}/pulls/${entry.pr}`);
    return { ...entry, merged_at: pr.merged_at };
  });

  const rows = [];
  for (const file of args.workflows) {
    const runs = await listRuns(file, args.since, args.until);
    const jobLists = await mapLimit(runs, 3, (workflowRun) => firstAttemptJobs(args.cache, workflowRun));
    runs.forEach((workflowRun, index) => {
      const row = jobLists[index] && rowFor(file, workflowRun, jobLists[index], prs);
      if (row) rows.push(row);
    });
    console.error(`${WORKFLOWS[file]}: ${runs.length} successful runs, ${rows.filter((row) => row.workflow_file === file).length} kept`);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.run_id - b.run_id);

  const annotations = prs.map((pr) => {
    const firstBranchRun = rows.find((row) => row.annotations.includes(pr.pr) && row.branch !== 'main');
    return {
      pr: pr.pr,
      date: (pr.merged_at || firstBranchRun?.date || '').slice(0, 10) || null,
      label: pr.label,
      workflows: pr.workflows,
      state: pr.merged_at ? 'merged' : 'open',
    };
  });

  const output = {
    repo: REPO,
    generated_at: new Date().toISOString(),
    since: args.since,
    until: args.until,
    wall_definition: 'first job started_at to last job completed_at, attempt 1, successful runs',
    annotations,
    runs: rows,
  };
  await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`);
  console.error(`Wrote ${rows.length} runs to ${args.out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
