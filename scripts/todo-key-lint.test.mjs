// The pane/no-bare-todo-number Oxlint rule (T-51, plan test 9): comparing a bare to-do number, or keying
// a Map, Set or record by one, fails outside shared/todoKey.ts. Two machines each have a T-28, so code
// compares TodoKeys instead. Runs Oxlint on fixture files in a temporary directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oxlintBin = path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');
const RULE = 'pane/no-bare-todo-number';

/** Lints `files` ({ relative path: source }) with only the rule on; returns the lines it reports, by file. */
function lint(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-key-lint-'));
  try {
    fs.writeFileSync(path.join(dir, '.oxlintrc.json'), JSON.stringify({
      plugins: [],
      jsPlugins: [{ name: 'pane', specifier: path.join(repoRoot, 'tools/oxlint/pane/index.ts') }],
      rules: { [RULE]: 'error' },
    }));
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), source);
    }
    const run = spawnSync(process.execPath, [oxlintBin, '--config', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    const reported = {};
    for (const line of `${run.stdout}${run.stderr}`.split('\n')) {
      const match = /^(.+?):(\d+):\d+: .*no-bare-todo-number/u.exec(line);
      if (match) (reported[match[1]] ??= []).push(Number(match[2]));
    }
    return { reported, status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const flagged = [
  'item.todo.number === row.todo.number;',
  'item.todo?.number !== row.todo.number;',
  'entry.todoNumber === wanted;',
  'approval.todo_id === todo.number;',
  'byNumber.get(item.todo.number);',
  'waiting.has(item.todo!.number);',
  'counts.set(row.todo.number, 1);',
  'numbers.includes(item.todo.number);',
  'new Set(rows.map(row => row.todo.number));',
  'new Set([item.todo.number]);',
  'new Map(rows.map(row => [row.todo.number, row]));',
  'new Map([[item.todo.number, item]]);',
  'counts[item.todo.number] = 1;',
  'const byRef = { [item.todo.number]: item };',
];

const allowed = [
  'const label = `T-${item.todo.number}`;',
  'todoRef(item.todo.number);',
  'const key = todoKey(machineId, item.todo.number);',
  'item.todo?.number != null;',
  'session.todoNumber !== undefined;',
  'byKey.get(todoKeyOfItem(item));',
  'new Set(rows.map(row => todoKeyOfRow(machineId, row)));',
  'todo.number === other.number;',
  'item.todo.number > 0;',
];

test('fails on item.todo.number === row.todo.number, the plan\'s fixture', () => {
  const { reported, output } = lint({ 'frontend/src/match.ts': 'export const same = (item, row) => item.todo.number === row.todo.number;\n' });
  assert.deepEqual(reported, { 'frontend/src/match.ts': [1] }, output);
});

test('fails on each comparison and key, one line each', () => {
  const { reported, output } = lint({ 'frontend/src/keys.ts': `${flagged.join('\n')}\n` });
  assert.deepEqual(reported['frontend/src/keys.ts'], flagged.map((_, index) => index + 1), output);
});

test('allows showing, passing on and presence checks, and TodoKeys', () => {
  const { reported, status, output } = lint({ 'frontend/src/shown.ts': `${allowed.join('\n')}\n` });
  assert.deepEqual(reported, {}, output);
  assert.equal(status, 0, output);
});

test('allows the helper module, shared/todoKey.ts', () => {
  const { reported, status, output } = lint({ 'shared/todoKey.ts': `${flagged.join('\n')}\n` });
  assert.deepEqual(reported, {}, output);
  assert.equal(status, 0, output);
});

test('is on in the repository config, which runs it in pnpm lint and CI', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.oxlintrc.json'), 'utf8'));
  assert.ok(config.jsPlugins.some(plugin => plugin.name === 'pane' && plugin.specifier === './tools/oxlint/pane/index.ts'));
  assert.equal(config.rules[RULE], 'error');
});
