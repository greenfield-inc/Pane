#!/usr/bin/env node
// Pull request lane selection for Code Quality, and the guard that checks it.
//
//   node scripts/ci-affected.mjs manifest   (in Detect changed areas) checks
//     the lane map, runs the reference guard over the whole tree, then prints
//     `skip=<json>` for $GITHUB_OUTPUT: the jobs this run may skip, each with
//     its reason. CI result (scripts/ci-gate.mjs) allows only those skips.
//   node scripts/ci-affected.mjs guard      runs only the map check and the
//     reference guard (pnpm check:fast runs it before a push).
//
// A lane is a set of Code Quality jobs plus the paths its tests can reach. A
// pull request skips a lane only when every changed path (old and new side
// of renames and deletes) is inside another lane's inputs or in LANE_FREE.
// Everything else runs every lane: a path no entry names (root config, the
// lockfile, patches, workflows, scripts), an empty diff, a missing base, and
// every event other than pull_request.
//
// The guard keeps the map honest. It scans each lane's inputs for paths
// into the rest of the repository, and fails when one lands in another
// lane's inputs or in LANE_FREE but outside this lane. (A path no entry names
// is fine to read: a change to it runs every lane.) It sees, outside comments:
//   - string literals that start with ./ or ../, from the file's folder and
//     from its workspace folder (the repository root for tests/ and scripts/);
//   - string literals that start with a top-level folder (`contracts/x`);
//   - join(), resolve() and new URL() of __dirname, import.meta, process.cwd()
//     or a name bound to a folder above the file
//     (`const root = join(__dirname, '..')`, then `join(root, 'claude-plugin')`);
//   - a climb followed by a computed part (`join(__dirname, '..', name)`,
//     `../${name}`), and any other use of such a root name, which fail as
//     unverifiable unless they stay inside the lane.
// It misses a path built entirely from variables or environment values, and a
// file a spawned program opens by itself. Only a merge queue that runs every
// lane would catch those; none is enabled yet.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_JOBS, workflowJobIds } from './ci-gate.mjs';

// Each lane: the Code Quality jobs it is, and every path their tests read.
// An entry ending in / is a folder; anything else is one file. The guard
// below finds most entries; a lane that runs a build also reads what that
// build reads.
const MAIN = [
  'main/', 'shared/',
  // Imported or read by main's tests.
  'packages/runpane/src/', 'packages/runpane-py/src/runpane/telemetry.py', 'frontend/src/',
  'packages/runpane/package.json', 'contracts/runpane/', 'claude-plugin/',
  'frontend/index.html', 'frontend/remote.html', 'tests/fixtures/notifySnapshot.ts',
  'scripts/pane-run-script.js', 'scripts/pane-remote-setup.js', 'scripts/import-agent-farm-profiles.js',
];
const RENDERER = [
  'frontend/', 'shared/', 'tests/', 'playwright.shared.ts',
  'main/src/services/chatTabs/testing/scriptedAgent.mjs', 'main/src/services/notify/summaryPage.ts',
];
// `runpane build` bundles every docs/*.md (packages/runpane/scripts/build-docs-index.js).
const RUNPANE = [
  'packages/runpane/', 'packages/runpane-py/', 'contracts/runpane/', 'docs/',
  'shared/types/generatedRunpaneContract.ts', 'shared/types/generatedAgents.ts',
  'main/package.json', 'main/src/daemon/__fixtures__/remote-daemon-start-v2.4.30.sh',
  'scripts/test-runpane-*', 'scripts/runpane-test-shard.js', 'scripts/fixtures/',
  'scripts/sync-runpane-package-versions.js', 'scripts/generate-runpane-contract.js', 'scripts/ci-background.sh',
];
const RELAY = ['relay/', 'direct/'];

export const LANES = {
  main: { jobs: ['main-tests', 'cross-os-main-tests'], inputs: MAIN },
  renderer: { jobs: ['functional-smoke-browser', 'renderer-selection', 'pwa-build'], inputs: RENDERER },
  // Builds main, which builds runpane (docs included), then runs Electron journeys.
  electron: { jobs: ['functional-smoke-electron'], inputs: [...MAIN, ...RENDERER, ...RUNPANE, 'scripts/smoke-sandboxed-preload.cjs'] },
  runpane: { jobs: ['runpane-wrapper-tests'], inputs: RUNPANE },
  'relay-rust': { jobs: ['relay-rust'], inputs: RELAY },
  // Main's relay suite against built relay and pane-direct binaries, then runpane relay.
  'relay-tests': { jobs: ['relay-tests'], inputs: [...RELAY, ...MAIN, ...RUNPANE] },
};

// Paths no lane reads. A change only here skips every lane; the always-run
// jobs (Quality Checks, Type Check and Lint, Markdown Links) still check it.
export const LANE_FREE = [
  'mobile/', 'native/', 'glasses/', 'tools/',
  'screenshots/', 'images/', 'briefs/', 'README.md', 'CONTRIBUTING.md', 'RUNBOOK.md', 'SECURITY.md',
];

// pnpm --filter names in quality.yml and the folder each one builds or tests.
const FILTERS = { main: 'main/', frontend: 'frontend/', runpane: 'packages/runpane/' };

// Paths the guard finds that a lane's tests do not read, each with why.
const NOT_READ = [
  ...['shared/types/generatedRunpaneContract.ts', 'contracts/runpane/contract.json', 'packages/runpane/src/generated/contract.ts'].map((file) => ({
    file, target: 'docs/PANE_MCP.md', why: 'the contract names this page as a link for readers; no code opens it',
  })),
  { file: 'main/src/services/sessionMove/gitSnapshot.test.ts', target: 'build', why: "an expected path inside the test's own scratch repository" },
  { file: 'scripts/test-runpane-contract.js', target: 'main/src/services/skillCacheManager.ts', why: 'asserts that output does not mention this path' },
  { file: 'scripts/test-runpane-relay.js', target: 'relay/Cargo.toml', lanes: ['runpane', 'electron'], why: 'Relay Tests runs this script and its lane lists relay/; Runpane Wrapper does not run it' },
  { file: 'packages/runpane/package.json', target: 'packages/runpane', why: "the npm manifest's repository.directory field" },
  { file: 'tests/theme-screenshots.spec.ts', target: 'screenshots/themes/batch', why: 'writes screenshots there and reads none' },
  ...['main/build-runpane.js', 'main/build-runpane-cli.js'].flatMap((file) => ['packages/runpane', 'packages/runpane/package.json', 'packages/runpane/scripts/build-docs-index.js'].map((target) => ({
    file, target, lanes: ['main', 'renderer'], why: "main's build step; main's and the renderer's tests never run it (the Electron, runpane and relay lanes, which build, list packages/runpane/)",
  }))),
];

const SCANNED = /\.(?:[cm]?[jt]sx?|json|rs|toml|py|sh|ya?ml|html)$/;
const HASH_COMMENTS = /\.(?:toml|py|sh|ya?ml)$/;

/**
 * String literals in source text, outside comments, with their line and the
 * code before each on that line. Template literals keep their static prefix
 * and record whether they contain a ${} expression.
 */
function stringLiterals(text, { hashComments = false } = {}) {
  const literals = [];
  const comments = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line += 1; i += 1; continue; }
    if ((hashComments && ch === '#') || (!hashComments && ch === '/' && text[i + 1] === '/')) {
      const start = i;
      while (i < n && text[i] !== '\n') i += 1;
      comments.push([start, i]);
      continue;
    }
    if (!hashComments && ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line += 1; i += 1; }
      i += 2;
      comments.push([start, i]);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      const startLine = line;
      let value = '';
      let dynamic = false;
      const expressions = [];
      i += 1;
      while (i < n && text[i] !== ch) {
        if (text[i] === '\\') { value += text[i + 1] ?? ''; i += 2; continue; }
        if (text[i] === '\n') {
          line += 1;
          if (ch !== '`') break;
        }
        if (ch === '`' && text[i] === '$' && text[i + 1] === '{') {
          dynamic = true;
          let depth = 1;
          i += 2;
          const exprStart = i;
          while (i < n && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            else if (text[i] === '\n') line += 1;
            i += 1;
          }
          expressions.push(text.slice(exprStart, i - 1));
          value += '\u0000';
          continue;
        }
        value += text[i];
        i += 1;
      }
      i += 1;
      literals.push({ value, dynamic, expressions, line: startLine, start, end: i });
      continue;
    }
    i += 1;
  }
  return { literals, comments };
}

/** Source text with comments blanked and each string literal replaced by spaces of the same length. */
function maskLiterals(text, literals, comments) {
  const chars = text.split('');
  for (const [start, end] of comments) for (let i = start; i < end; i += 1) chars[i] = ' ';
  for (const literal of literals) {
    for (let i = literal.start; i < literal.end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
    chars[literal.start] = '\u0001';
  }
  return chars.join('');
}

/** Top-level arguments of the call whose `(` is at `open`, as [start, end) spans. */
function callArguments(masked, open) {
  const spans = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { spans.push([start, i]); return spans; }
    } else if (ch === ',' && depth === 1) { spans.push([start, i]); start = i + 1; }
  }
  return null;
}

const FILE_BASE = /__dirname|import\.meta|fileURLToPath|__filename/;
const CWD_BASE = /process\.cwd\(\)/;

/**
 * The repository paths a file names. Each reference is
 * `{ line, candidates: [{ from, path }], computed }`: `from` is 'file',
 * 'workspace' or 'repo' (a top-level folder), and `computed` marks a
 * climb followed by a part the guard cannot read.
 */
function fileReferences(text, file) {
  const { literals, comments } = stringLiterals(text, { hashComments: HASH_COMMENTS.test(file) });
  const refs = [];
  const relative = (value, bases) => bases.map((from) => ({ from, path: value }));
  const fromLiteral = (value, line, computed = false) => {
    if (/^(?:\.\.?\/?)+$/.test(value) && !computed) return;
    if (value.startsWith('./') || value.startsWith('../')) {
      refs.push({ line, candidates: relative(value, ['file', 'workspace']), computed });
    } else if (/^[A-Za-z0-9_.@-]+\//.test(value)) {
      refs.push({ line, candidates: relative(value, ['repo']), computed });
    }
  };
  const consumed = new Set();
  const masked = maskLiterals(text, literals, comments);
  const templateCode = literals.flatMap((literal) => literal.expressions).join('\n');
  const byStart = new Map(literals.map((literal) => [literal.start, literal]));
  const calls = [];
  const call = /\b(?:join|resolve|URL)\s*\(/g;
  let match;
  while ((match = call.exec(masked))) {
    const spans = callArguments(masked, match.index + match[0].length - 1);
    if (!spans) continue;
    const args = spans.map(([start, end]) => {
      const raw = masked.slice(start, end);
      const trimmedStart = start + (raw.length - raw.trimStart().length);
      const literal = byStart.get(trimmedStart);
      const whole = literal && masked.slice(literal.end, end).trim() === '';
      if (whole && !literal.dynamic) return { value: literal.value, start: literal.start };
      return { code: text.slice(start, end).trim() };
    });
    const declared = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.|posix\.)?$/.exec(masked.slice(Math.max(0, match.index - 80), match.index));
    calls.push({ index: match.index, spans, args, name: declared?.[1] });
  }

  // A name bound to a folder above this file
  // (`const repoRoot = join(__dirname, '..', '..')`). Joins onto it resolve
  // from that folder; any other use of the name is reported, because the
  // guard cannot follow it.
  const bindings = new Map();
  for (const { args, name, index } of calls) {
    if (!name || args.length < 2 || !FILE_BASE.test(args[0].code ?? '') || args.slice(1).some((arg) => arg.value === undefined)) continue;
    const folder = path.posix.join(...args.slice(1).map((arg) => arg.value));
    if (!/^\.\.(?:\/\.\.)*$/.test(folder)) continue;
    const uses = [...masked.matchAll(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'))];
    const followed = uses.filter((use) => /\b(?:join|resolve|relative)\s*\(\s*$/.test(masked.slice(Math.max(0, use.index - 40), use.index))).length;
    const inTemplates = [...templateCode.matchAll(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'))].length;
    bindings.set(name, { folder, unfollowed: uses.length - 1 - followed + inTemplates, line: text.slice(0, index).split('\n').length });
  }
  for (const [, binding] of bindings) {
    if (binding.unfollowed > 0) refs.push({ line: binding.line, candidates: relative(binding.folder, ['file']), computed: true, binding: true });
  }

  for (const { spans, args, name } of calls) {
    for (let i = 0; i < args.length; i += 1) {
      if (args[i].value === undefined) continue;
      let j = i;
      while (j < args.length && args[j].value !== undefined) j += 1;
      const joined = path.posix.join(...args.slice(i, j).map((arg) => arg.value));
      const base = i > 0 ? args[i - 1].code : null;
      const computed = j < args.length;
      const line = text.slice(0, spans[i][0]).split('\n').length;
      for (const arg of args.slice(i, j)) consumed.add(arg.start);
      const bound = base && bindings.get(base);
      if (bound) refs.push({ line, candidates: relative(path.posix.join(bound.folder, joined), ['file']), computed });
      else if (base && FILE_BASE.test(base)) {
        if (!(name && bindings.has(name) && !computed)) refs.push({ line, candidates: relative(joined, ['file']), computed });
      } else if (base && CWD_BASE.test(base)) refs.push({ line, candidates: relative(joined, ['workspace', 'repo']), computed });
      else if (joined.startsWith('..')) {
        if (!base) refs.push({ line, candidates: relative(joined, ['file', 'workspace']), computed });
      } else if (/^[A-Za-z0-9_.@-]+\/[^/]/.test(joined)) {
        refs.push({ line, candidates: relative(joined, ['repo']), computed });
      }
      i = j;
    }
  }
  for (const literal of literals) {
    if (consumed.has(literal.start)) continue;
    if (!literal.dynamic) { fromLiteral(literal.value, literal.line); continue; }
    const prefix = literal.value.slice(0, literal.value.indexOf('\u0000'));
    const folder = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    if (folder.startsWith('../') || folder.startsWith('./')) fromLiteral(folder, literal.line, true);
  }
  return refs;
}

// Folders whose tests run with that folder as the working directory. Other
// files (tests/, scripts/) run from the repository root.
const WORKSPACES = ['main/', 'frontend/', 'shared/', 'mobile/', 'native/', 'glasses/', 'packages/runpane-py/', 'packages/runpane/', 'relay/', 'direct/'];
const SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json', '.d.ts', '/index.ts', '/index.tsx', '/index.js'];

/** Tracked files and every folder that holds one. */
function treeIndex(files) {
  const fileSet = new Set(files);
  const dirs = new Set(['']);
  for (const file of files) {
    let dir = path.posix.dirname(file);
    while (dir !== '.' && !dirs.has(dir)) { dirs.add(dir); dir = path.posix.dirname(dir); }
  }
  const topDirs = new Set(files.map((file) => file.split('/')[0]).filter((top) => dirs.has(top)));
  return { files: fileSet, dirs, topDirs };
}

function workspaceOf(file) {
  return (WORKSPACES.find((ws) => file.startsWith(ws)) ?? '/').slice(0, -1);
}

/** The tracked path a candidate names, or null when it names nothing in the repository. */
function resolveCandidate(file, { from, path: target }, tree) {
  if (from === 'repo' && !tree.topDirs.has(target.split('/')[0])) return null;
  const base = { file: path.posix.dirname(file), workspace: workspaceOf(file), repo: '' }[from];
  let resolved = path.posix.normalize(path.posix.join(base || '.', target)).replace(/\/+$/, '');
  if (resolved === '.') resolved = '';
  if (resolved.startsWith('..')) return null;
  if (tree.dirs.has(resolved)) return { path: resolved, dir: true };
  for (const suffix of SUFFIXES) {
    for (const stem of [resolved, resolved.replace(/\.[cm]?js$/, '')]) {
      if (tree.files.has(stem + suffix)) return { path: stem + suffix, dir: false };
    }
  }
  return null;
}

/** Whether a tracked path is inside a list of inputs (folders end in /). */
function covers(inputs, target, dir = false) {
  const probe = dir ? `${target}/` : target;
  return inputs.some((input) => (input.endsWith('/') || input.endsWith('*') ? probe.startsWith(input.replace(/\*$/, '')) : probe === input));
}

/** Problems with the lane map itself: an empty map, a job the gate does not know, an entry that names no file. */
export function mapProblems({ lanes, laneFree, files, workflowText }) {
  const problems = [];
  const workflowJobs = workflowJobIds(workflowText);
  if (Object.keys(lanes).length === 0) problems.push('LANES is empty, so nothing could be selected.');
  const seen = new Map();
  for (const [lane, { jobs, inputs }] of Object.entries(lanes)) {
    if (!jobs?.length) problems.push(`lane ${lane}: names no job.`);
    if (!inputs?.length) problems.push(`lane ${lane}: names no input.`);
    for (const job of jobs ?? []) {
      if (seen.has(job)) problems.push(`lane ${lane}: job ${job} is also in lane ${seen.get(job)}.`);
      seen.set(job, lane);
      if (!EXPECTED_JOBS.includes(job)) problems.push(`lane ${lane}: job ${job} is not in scripts/ci-gate.mjs EXPECTED_JOBS.`);
      if (!workflowJobs.includes(job)) problems.push(`lane ${lane}: job ${job} is not in quality.yml.`);
    }
    for (const input of inputs ?? []) {
      if (!files.some((file) => covers([input], file))) problems.push(`lane ${lane}: input ${input} names no tracked file.`);
    }
  }
  for (const entry of laneFree) {
    if (!files.some((file) => covers([entry], file))) problems.push(`LANE_FREE entry ${entry} names no tracked file.`);
  }

  // Every path and pnpm filter a lane's job names in quality.yml is in that
  // lane's inputs, or in no entry at all (so a change to it runs everything).
  const tree = treeIndex(files);
  const entries = [...Object.values(lanes).flatMap(({ inputs }) => inputs ?? []), ...laneFree];
  for (const [lane, { jobs, inputs }] of Object.entries(lanes)) {
    for (const job of jobs ?? []) {
      const block = jobBlock(workflowText, job);
      const named = [...block.matchAll(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g)].map((m) => m[0])
        .map((name) => resolveCandidate('', { from: 'repo', path: name }, tree)).filter(Boolean);
      for (const m of block.matchAll(/--filter\s+'?([A-Za-z0-9_-]+)/g)) {
        if (!FILTERS[m[1]]) problems.push(`lane ${lane}: job ${job} filters pnpm workspace ${m[1]}, which FILTERS does not map to a folder.`);
        else named.push({ path: FILTERS[m[1]].slice(0, -1), dir: true });
      }
      for (const target of named) {
        const inLane = covers(inputs, target.path, target.dir);
        const named = covers(entries, target.path, target.dir) || (target.dir && entries.some((entry) => entry.startsWith(`${target.path}/`)));
        if (!inLane && named) problems.push(`lane ${lane}: job ${job} names ${target.path} in quality.yml, which is outside the lane's inputs.`);
      }
    }
  }
  return problems;
}

/** One job's lines in a workflow file. */
function jobBlock(workflowText, job) {
  const lines = workflowText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`  ${job}:`));
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/**
 * Every reference from a lane's inputs to a path that selects lanes but not
 * this one. `read(file)`
 * returns a tracked file's text.
 */
export function guardViolations({ lanes, laneFree = LANE_FREE, files, read, notRead = NOT_READ }) {
  const tree = treeIndex(files);
  // A path no entry names runs every lane when it changes, so any lane may read it.
  const entries = [...Object.values(lanes).flatMap(({ inputs }) => inputs), ...laneFree];
  const selects = ({ path: target, dir }) => covers(entries, target, dir)
    || (dir && entries.some((entry) => entry.startsWith(target ? `${target}/` : '')));
  const violations = [];
  const refsByFile = new Map();
  const refsOf = (file) => {
    if (!refsByFile.has(file)) refsByFile.set(file, SCANNED.test(file) ? fileReferences(read(file), file) : []);
    return refsByFile.get(file);
  };
  for (const [lane, { inputs }] of Object.entries(lanes)) {
    for (const file of files) {
      if (!covers(inputs, file)) continue;
      for (const ref of refsOf(file)) {
        for (const candidate of ref.candidates) {
          const target = resolveCandidate(file, candidate, tree);
          if (!target || covers(inputs, target.path, target.dir) || !selects(target)) continue;
          // A name for the folder the file already runs in (scripts/ run from the
          // repository root): the paths it names are checked as they appear.
          if (ref.binding && target.path === workspaceOf(file)) continue;
          if (notRead.some((entry) => entry.file === file && entry.target === target.path && (!entry.lanes || entry.lanes.includes(lane)))) continue;
          violations.push({ lane, file, line: ref.line, target: target.path || '.', computed: ref.computed });
        }
      }
    }
  }
  const unique = new Map(violations.map((v) => [`${v.lane} ${v.file}:${v.line} ${v.target}`, v]));
  return [...unique.values()];
}

/**
 * The jobs a run may skip, each with its reason. `changed` is the list of
 * changed paths, or null when the base could not be read.
 */
export function selection({ event, changed, lanes = LANES, laneFree = LANE_FREE }) {
  const runAll = (why) => ({ skip: {}, why });
  if (event !== 'pull_request') return runAll(`a ${event ?? 'unknown'} run checks everything`);
  if (changed === null) return runAll('the pull request base could not be read');
  if (changed.length === 0) return runAll('the diff lists no files');
  const unknown = changed.filter((file) => !covers(laneFree, file)
    && !Object.values(lanes).some(({ inputs }) => covers(inputs, file)));
  if (unknown.length > 0) return runAll(`${unknown[0]}${unknown.length > 1 ? ` and ${unknown.length - 1} more` : ''} is in no lane's inputs`);
  const skip = {};
  for (const [lane, { jobs, inputs }] of Object.entries(lanes)) {
    if (changed.some((file) => covers(inputs, file))) continue;
    for (const job of jobs) skip[job] = `no changed path is in the ${lane} lane's inputs`;
  }
  return { skip, why: `${changed.length} changed path${changed.length === 1 ? '' : 's'}, all inside lane inputs or LANE_FREE` };
}

const REPO = fileURLToPath(new URL('..', import.meta.url));

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30 });
  return result.status === 0 ? result.stdout : null;
}

/** The pull request's changed paths: the merge commit against its first parent, both sides of renames. */
function changedPaths() {
  if (git(['rev-parse', '--verify', '--quiet', 'HEAD^2']) === null) return null;
  const listing = git(['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD']);
  return listing === null ? null : listing.split('\n').filter(Boolean);
}

function runGuard() {
  const listing = git(['ls-files', '-z']);
  if (listing === null) throw new Error('git ls-files failed, so the guard cannot read the tree.');
  const files = listing.split('\0').filter(Boolean);
  const problems = mapProblems({
    lanes: LANES,
    laneFree: LANE_FREE,
    files,
    workflowText: readFileSync(path.join(REPO, '.github/workflows/quality.yml'), 'utf8'),
  });
  for (const v of guardViolations({ lanes: LANES, files, read: (file) => readFileSync(path.join(REPO, file), 'utf8') })) {
    problems.push(`${v.file}:${v.line} ${v.computed ? 'builds a path under' : 'reads'} ${v.target}, which is outside the ${v.lane} lane's inputs in scripts/ci-affected.mjs. Add it to that lane (or to NOT_READ with a reason), or a change there skips this lane.`);
  }
  for (const problem of problems) console.log(`::error title=Lane selection::${problem}`);
  return problems.length === 0;
}

function main() {
  const [command] = process.argv.slice(2);
  if (command !== 'guard' && command !== 'manifest') throw new Error(`Unknown command ${command ?? '(none)'}. Use \`guard\` or \`manifest\`.`);
  if (!runGuard()) { process.exitCode = 1; return; }
  if (command === 'guard') { console.log('Lane map and reference guard: ok.'); return; }
  const event = process.env.GITHUB_EVENT_NAME;
  const changed = event === 'pull_request' ? changedPaths() : [];
  const { skip, why } = selection({ event, changed });
  const lines = [`### Lane selection`, '', `Runs everything unless every changed path is inside a lane: ${why}.`, ''];
  for (const [job, reason] of Object.entries(skip)) lines.push(`- skip ${job}: ${reason}`);
  if (Object.keys(skip).length === 0) lines.push('- every lane runs');
  const markdown = `${lines.join('\n')}\n`;
  process.stderr.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(`skip=${JSON.stringify(skip)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
