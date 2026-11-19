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
import { LANES as TEST_LANES } from './ci-test-inventory.mjs';

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
  renderer: { jobs: ['functional-smoke-browser', 'functional-smoke-webgl', 'renderer-selection', 'pwa-build'], inputs: RENDERER },
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

// After these, a `/` starts a regex literal rather than a division.
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const KEYWORD_BEFORE_REGEX = /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

/**
 * String literals in source text, outside comments and regex literals, with
 * their line. Template literals keep their text with each ${} as \u0000, and
 * the code of each ${}. `unterminated` is the line of a template literal that
 * never closes, after which nothing in the file can be read.
 */
function stringLiterals(text, { hashComments = false } = {}) {
  const literals = [];
  const comments = [];
  let unterminated = null;
  let line = 1;
  let i = 0;
  let previous = '';
  let word = '';
  let lastWord = '';
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
    if (!hashComments && ch === '/' && (BEFORE_REGEX.has(previous) || (word === '' && KEYWORD_BEFORE_REGEX.test(lastWord) && previous === lastWord.at(-1)))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      if (j < n && text[j] === '/') {
        i = j + 1;
        while (i < n && /[a-z]/.test(text[i])) i += 1;
        previous = 'x';
        word = '';
        continue;
      }
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
      if (ch === '`' && i >= n) unterminated = startLine;
      i += 1;
      literals.push({ value, dynamic, expressions, line: startLine, start, end: i });
      previous = 'x';
      word = '';
      continue;
    }
    if (/[\w$]/.test(ch)) word += ch;
    else if (!/\s/.test(ch)) { if (word) lastWord = word; word = ''; }
    else if (word) { lastWord = word; word = ''; }
    if (!/\s/.test(ch)) previous = ch;
    i += 1;
  }
  return { literals, comments, unterminated };
}

/** Source text with comments blanked and each string literal replaced by spaces of the same length. */
function maskLiterals(text, literals, comments) {
  const chars = text.split('');
  for (const [start, end] of comments) for (let i = start; i < end; i += 1) chars[i] = ' ';
  for (const literal of literals) {
    for (let i = literal.start; i < literal.end && i < chars.length; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
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

const CWD_BASE = /process\.cwd\(\)/;
const PURE_CLIMB = /^(?:\.|\.\.(?:\/\.\.)*)$/;

/**
 * The folder, relative to the file's own folder, that an expression built
 * from the file's location names: `__dirname` is '.', `dirname(__dirname)`
 * is '..', `fileURLToPath(new URL('../..', import.meta.url))` is '../..'.
 * Null when the expression does not start from the file's location.
 */
function fileBaseFolder(code) {
  const compact = code.replace(/\s+/g, '').replace(/\b(?:path|posix|url)\./g, '');
  const shape = /^((?:dirname\()*)(__dirname|import\.meta\.dirname|__filename|import\.meta\.filename|fileURLToPath\(import\.meta\.url\)|fileURLToPath\(newURL\((['"`])([^'"`$]*)\3,import\.meta\.url\)\))(\)*)$/.exec(compact);
  if (!shape) return null;
  const climbs = shape[1].length / 'dirname('.length;
  if (shape[5].length !== climbs) return null;
  const start = shape[4] !== undefined ? shape[4] || '.' : '.';
  // A file's path (import.meta.url, __filename) needs one dirname to be its folder.
  const fileItself = shape[4] === undefined && !/__dirname|import\.meta\.dirname/.test(shape[2]);
  return path.posix.join(start, ...(fileItself ? ['_file_'] : []), ...Array(climbs).fill('..'));
}

/** The operand that ends just before `end` in masked code: a name chain, or a call such as `dirname(x)`. */
function operandBefore(masked, end) {
  let i = end;
  while (i > 0 && /\s/.test(masked[i - 1])) i -= 1;
  const stop = i;
  if (masked[i - 1] === ')') {
    let depth = 0;
    while (i > 0) {
      i -= 1;
      if (masked[i] === ')') depth += 1;
      else if (masked[i] === '(' && --depth === 0) break;
    }
  }
  while (i > 0 && /[\w$.]/.test(masked[i - 1])) i -= 1;
  return masked.slice(i, stop);
}

/**
 * The repository paths a file names. Each reference is
 * `{ line, candidates: [{ from, path }], computed }`: `from` is 'file',
 * 'workspace' or 'repo' (a top-level folder), and `computed` marks a
 * climb followed by a part the guard cannot read. `unreadable` marks a file
 * the scanner cannot read past one line.
 */
function fileReferences(text, file) {
  const { literals, comments, unterminated } = stringLiterals(text, { hashComments: HASH_COMMENTS.test(file) });
  const refs = [];
  if (unterminated !== null) refs.push({ line: unterminated, candidates: [], unreadable: true });
  const relative = (value, bases) => bases.map((from) => ({ from, path: value }));
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const fromLiteral = (value, line, computed = false) => {
    if (/^[./]*$/.test(value) && !computed) return;
    if (value.startsWith('./') || value.startsWith('../')) {
      refs.push({ line, candidates: relative(value, ['file', 'workspace']), computed });
    } else if (/^[A-Za-z0-9_.@-]+\//.test(value)) {
      refs.push({ line, candidates: relative(value, ['repo']), computed });
    }
  };
  const consumed = new Set();
  const masked = maskLiterals(text, literals, comments);
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
    calls.push({ index: match.index, spans, args });
  }

  // Names bound to the file's folder or a folder above it
  // (`const root = join(__dirname, '..', '..')`, `dirname(dirname(__dirname))`,
  // `fileURLToPath(new URL('..', import.meta.url))`). Paths built on them
  // resolve from that folder; any other use of a name above the file is
  // reported, because the guard cannot follow it.
  const bindings = new Map();
  const callAt = new Map(calls.map((entry) => [entry.index, entry]));
  for (const declaration of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const exprStart = declaration.index + declaration[0].length;
    const rest = masked.slice(exprStart);
    const end = rest.search(/[;\n]/);
    const expr = text.slice(exprStart, exprStart + (end === -1 ? rest.length : end));
    let folder = null;
    const head = /^(?:path\.|posix\.)?(?:join|resolve)\s*\(/.exec(rest);
    const joinCall = head && callAt.get(exprStart + head[0].search(/(?:join|resolve)/));
    if (joinCall) {
      const base = fileBaseFolder(joinCall.args[0]?.code ?? '');
      if (base !== null && joinCall.args.slice(1).every((arg) => arg.value !== undefined)) {
        folder = path.posix.join(base, ...joinCall.args.slice(1).map((arg) => arg.value));
      }
    } else folder = fileBaseFolder(expr);
    if (folder === null || !PURE_CLIMB.test(folder)) continue;
    bindings.set(declaration[1], {
      folder, line: lineAt(declaration.index), declared: declaration.index + declaration[0].indexOf(declaration[1], 3), span: [exprStart, exprStart + expr.length],
    });
  }
  const baseFolder = (code) => {
    const name = code.trim();
    return bindings.has(name) ? bindings.get(name).folder : fileBaseFolder(code);
  };

  // Templates and concatenations that start at the file's location:
  // `${__dirname}/../x`, `${root}/x`, `__dirname + '/../x'`.
  const followedTemplates = new Set();
  for (const literal of literals) {
    if (!literal.dynamic || !literal.value.startsWith('\u0000')) continue;
    const base = baseFolder(literal.expressions[0]);
    if (base === null) continue;
    followedTemplates.add(literal);
    consumed.add(literal.start);
    const tail = literal.value.slice(1);
    const cut = tail.indexOf('\u0000');
    const computed = cut !== -1;
    const staticTail = computed ? tail.slice(0, tail.slice(0, cut).lastIndexOf('/') + 1) : tail;
    refs.push({ line: literal.line, candidates: relative(path.posix.join(base, `.${staticTail}`), ['file']), computed });
  }
  for (const plus of masked.matchAll(/\+\s*\u0001/g)) {
    const base = baseFolder(operandBefore(masked, plus.index));
    const literal = byStart.get(plus.index + plus[0].length - 1);
    if (base === null || !literal) continue;
    consumed.add(literal.start);
    const value = literal.dynamic ? literal.value.slice(0, literal.value.indexOf('\u0000')) : literal.value;
    refs.push({ line: literal.line, candidates: relative(path.posix.join(base, `.${value}`), ['file']), computed: literal.dynamic });
  }

  for (const [name, binding] of bindings) {
    if (binding.folder === '.') continue;
    const pattern = `(?<![\\w$])${name.replace(/[$\\]/g, '\\$&')}(?![\\w$])`;
    const inCode = [...masked.matchAll(new RegExp(pattern, 'g'))].filter((use) => use.index !== binding.declared
      && !/\b(?:join|resolve|relative)\s*\(\s*$/.test(masked.slice(Math.max(0, use.index - 40), use.index))
      && !/^\s*\+\s*\u0001/.test(masked.slice(use.index + name.length)));
    const inTemplates = literals.flatMap((literal) => literal.expressions
      .filter((code, k) => !(k === 0 && followedTemplates.has(literal) && code.trim() === name))
      .filter((code) => new RegExp(pattern).test(code)));
    const unfollowed = inCode.length + inTemplates.length;
    if (unfollowed > 0) refs.push({ line: binding.line, candidates: relative(binding.folder, ['file']), computed: true, binding: true });
  }

  const inBinding = (index) => [...bindings.values()].some(({ span: [start, end] }) => index >= start && index < end);
  for (const { index, spans, args } of calls) {
    // A root name's own definition is followed through its uses instead.
    if (inBinding(index)) {
      for (const arg of args) if (arg.start !== undefined) consumed.add(arg.start);
      continue;
    }
    for (let i = 0; i < args.length; i += 1) {
      if (args[i].value === undefined) continue;
      let j = i;
      while (j < args.length && args[j].value !== undefined) j += 1;
      const joined = path.posix.join(...args.slice(i, j).map((arg) => arg.value));
      const base = i > 0 ? args[i - 1].code : null;
      const computed = j < args.length;
      const line = lineAt(spans[i][0]);
      for (const arg of args.slice(i, j)) consumed.add(arg.start);
      const folder = base && baseFolder(base);
      if (folder !== null && folder !== undefined && base) {
        refs.push({ line, candidates: relative(path.posix.join(folder, joined), ['file']), computed });
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
export function mapProblems({ lanes, laneFree, files, workflowText, testLanes = [] }) {
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

  // Every test file the test inventory names for a lane's job is in that lane,
  // or in no entry at all.
  for (const { workflow, job, list } of testLanes) {
    const lane = Object.entries(lanes).find(([, { jobs }]) => jobs?.includes(job))?.[0];
    if (workflow !== 'quality.yml' || !lane) continue;
    const named = list.named ?? (list.glob ? files.filter((file) => list.glob.test(file)) : []);
    for (const file of named) {
      if (!covers(lanes[lane].inputs, file) && covers(entries, file)) problems.push(`lane ${lane}: job ${job} runs ${file} (scripts/ci-test-inventory.mjs), which is outside the lane's inputs.`);
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
        if (ref.unreadable) violations.push({ lane, file, line: ref.line, target: '(unreadable)', unreadable: true });
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
    testLanes: TEST_LANES,
  });
  for (const v of guardViolations({ lanes: LANES, files, read: (file) => readFileSync(path.join(REPO, file), 'utf8') })) {
    if (v.unreadable) {
      problems.push(`${v.file}:${v.line} opens a template literal that never closes, so the guard cannot read the rest of the file for the ${v.lane} lane. Fix the file, or the scanner in scripts/ci-affected.mjs if the file is valid.`);
      continue;
    }
    problems.push(`${v.file}:${v.line} ${v.computed ? 'builds a path under' : 'reads'} ${v.target}, which is outside the ${v.lane} lane's inputs in scripts/ci-affected.mjs. Add it to that lane (or to NOT_READ with a reason), or a change there skips this lane.`);
  }
  for (const problem of problems) console.error(`::error title=Lane selection::${problem}`);
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
