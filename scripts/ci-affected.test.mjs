// node --test scripts/ci-affected.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guardViolations, mapProblems, selection } from './ci-affected.mjs';

const LANES = {
  main: { jobs: ['main-tests'], inputs: ['main/', 'lib/'] },
  frontend: { jobs: ['pwa-build'], inputs: ['frontend/', 'lib/'] },
};
const LANE_FREE = ['notes/'];
const pr = (changed) => selection({ event: 'pull_request', changed, lanes: LANES, laneFree: LANE_FREE });

test('a pull request skips the lanes no changed path reaches', () => {
  assert.deepEqual(Object.keys(pr(['frontend/page.ts']).skip), ['main-tests']);
  assert.deepEqual(Object.keys(pr(['lib/util.ts']).skip), []);
  assert.deepEqual(Object.keys(pr(['notes/a.md']).skip), ['main-tests', 'pwa-build']);
});

test('a rename or delete selects by both of its sides', () => {
  // git diff --no-renames lists a rename as the deleted and the added path.
  assert.deepEqual(Object.keys(pr(['notes/a.md', 'main/a.md']).skip), ['pwa-build']);
  assert.deepEqual(Object.keys(pr(['main/gone.ts']).skip), ['pwa-build']);
});

test('everything runs for an unmapped path, an empty diff, a missing base and other events', () => {
  assert.deepEqual(pr(['package.json', 'frontend/page.ts']), { skip: {}, why: "package.json is in no lane's inputs" });
  assert.deepEqual(pr([]).skip, {});
  assert.deepEqual(pr(null).skip, {});
  assert.deepEqual(selection({ event: 'merge_group', changed: ['notes/a.md'], lanes: LANES, laneFree: LANE_FREE }).skip, {});
  assert.deepEqual(selection({ event: 'push', changed: ['notes/a.md'], lanes: LANES, laneFree: LANE_FREE }).skip, {});
});

const FILES = [
  'main/src/a.ts', 'main/src/b.ts', 'lib/util.ts', 'frontend/page.ts', 'frontend/assets/logo.png',
  'notes/a.md', 'scripts/tool.js', 'package.json',
];
const scan = (sources, notRead = []) => guardViolations({
  lanes: LANES,
  laneFree: LANE_FREE,
  files: [...FILES, ...Object.keys(sources).filter((file) => !FILES.includes(file))],
  read: (file) => sources[file] ?? '',
  notRead,
}).map(({ lane, file, line, target }) => `${lane} ${file}:${line} ${target}`);

test('the guard passes reads inside the lane and reads of unmapped paths', () => {
  assert.deepEqual(scan({
    'main/src/a.ts': "import { x } from '../../lib/util';\nimport './b';\nconst p = require('../../package.json');\nconst t = readFileSync('scripts/tool.js');",
  }), []);
});

test('the guard finds each form of read into another lane', () => {
  assert.deepEqual(scan({ 'main/src/a.ts': "import page from '../../frontend/page';" }), ['main main/src/a.ts:1 frontend/page.ts']);
  assert.deepEqual(scan({ 'main/src/a.ts': "readFileSync('frontend/assets/logo.png');" }), ['main main/src/a.ts:1 frontend/assets/logo.png']);
  assert.deepEqual(scan({ 'main/src/a.ts': "x;\nconst p = path.join(__dirname, '..', '..', 'frontend', 'page.ts');" }), ['main main/src/a.ts:2 frontend/page.ts']);
  assert.deepEqual(scan({ 'main/src/a.ts': "const p = resolve(process.cwd(), '..', 'notes', 'a.md');" }), ['main main/src/a.ts:1 notes/a.md']);
  assert.deepEqual(scan({ 'main/src/a.ts': "const u = new URL('../../notes/a.md', import.meta.url);" }), ['main main/src/a.ts:1 notes/a.md']);
});

test('the guard follows a name for the repository root', () => {
  const source = "const repoRoot = path.join(__dirname, '..', '..');\nconst front = path.join(repoRoot, 'frontend');\nconst lib = path.join(repoRoot, 'lib', 'util.ts');";
  assert.deepEqual(scan({ 'main/src/a.ts': source }), ['main main/src/a.ts:2 frontend']);
});

test('the guard fails a root name it cannot follow, and a computed climb out of the lane', () => {
  assert.deepEqual(scan({ 'main/src/a.ts': "const root = join(__dirname, '../..');\nspawn('node', ['x'], { cwd: root });" }), ['main main/src/a.ts:1 .']);
  assert.deepEqual(scan({ 'main/src/a.ts': "const root = join(__dirname, '../..');\nconst f = `${root}/frontend/page.ts`;" }), ['main main/src/a.ts:1 .']);
  assert.deepEqual(scan({ 'main/src/a.ts': "const p = join(__dirname, '..', '..', name);" }), ['main main/src/a.ts:1 .']);
  assert.deepEqual(scan({ 'main/src/a.ts': 'const p = `../../${dir}/page.ts`;' }), ['main main/src/a.ts:1 .']);
});

test('the guard ignores comments and honours NOT_READ for the named file and lane', () => {
  assert.deepEqual(scan({ 'main/src/a.ts': "// see '../../frontend/page'\n/* frontend/page.ts */\nconst ok = 1;" }), []);
  const source = { 'main/src/a.ts': "expect(paths).toEqual(['frontend/assets/logo.png']);" };
  assert.deepEqual(scan(source, [{ file: 'main/src/a.ts', target: 'frontend/assets/logo.png', lanes: ['main'] }]), []);
  assert.deepEqual(scan(source, [{ file: 'main/src/a.ts', target: 'frontend/assets/logo.png', lanes: ['frontend'] }]), ['main main/src/a.ts:1 frontend/assets/logo.png']);
});

const WORKFLOW = `jobs:
  main-tests:
    steps:
    - run: node main/src/a.ts
  pwa-build:
    steps:
    - run: pnpm --filter website build && node scripts/tool.js
  ci-result:
    steps: []
`;

test('the map check accepts a sound map and rejects a broken one', () => {
  const check = (lanes, laneFree = LANE_FREE, workflowText = WORKFLOW) => mapProblems({ lanes, laneFree, files: FILES, workflowText });
  assert.deepEqual(check(LANES), ["lane frontend: job pwa-build filters pnpm workspace website, which FILTERS does not map to a folder."]);
  const sound = { ...LANES, frontend: { ...LANES.frontend } };
  const workflow = WORKFLOW.replace('--filter website ', '');
  assert.deepEqual(check(sound, LANE_FREE, workflow), []);
  assert.deepEqual(check({}, LANE_FREE, workflow), ['LANES is empty, so nothing could be selected.']);
  assert.deepEqual(check({ ...sound, extra: { jobs: ['not-a-job'], inputs: ['gone/'] } }, LANE_FREE, workflow), [
    'lane extra: job not-a-job is not in scripts/ci-gate.mjs EXPECTED_JOBS.',
    'lane extra: job not-a-job is not in quality.yml.',
    'lane extra: input gone/ names no tracked file.',
  ]);
  assert.deepEqual(check(sound, ['notes/', 'gone/'], workflow), ['LANE_FREE entry gone/ names no tracked file.']);
  assert.deepEqual(check(sound, LANE_FREE, workflow.replace('main/src/a.ts', 'frontend/page.ts')), [
    'lane main: job main-tests names frontend/page.ts in quality.yml, which is outside the lane\'s inputs.',
  ]);
});
