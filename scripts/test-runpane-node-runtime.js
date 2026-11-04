const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertSupportedNodeRuntime, assertSupportedCliRuntime } = require('../packages/runpane/dist/nodeRuntime');
const { main } = require('../packages/runpane/dist/cli');
const { RUNPANE_CONTRACT } = require('../packages/runpane/dist/generated/contract');

test('published engine and shared contract match the patched development baseline', () => {
  const root = require('../package.json').engines.node;
  assert.equal(require('../packages/runpane/package.json').engines.node, root);
  assert.equal(RUNPANE_CONTRACT.compatibility.node, root);
});

test('runtime guard accepts patched supported lines and rejects vulnerable, EOL and unreviewed lines', () => {
  for (const version of ['22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) {
    assert.doesNotThrow(() => assertSupportedNodeRuntime(version), version);
  }
  for (const version of ['20.0.0', '20.20.0', '22.23.3', '24.18.0', '24.22.0', '26.12.0', '23.0.0', '25.0.0', '28.0.0', '24.22.1-rc.1', 'invalid']) {
    assert.throws(() => assertSupportedNodeRuntime(version), { code: 'ERR_NODE_RUNTIME' }, version);
  }
});

test('CLI rejects an unsupported runtime before even dispatching an install dry run', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: '24.22.0' });
    await assert.rejects(main(['install', '--dry-run']), { code: 'ERR_NODE_RUNTIME' });
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor);
  }
});

test('managed CLI admits only the audited embedded pair below the standalone floor', () => {
  const electron = require('../main/package.json').devDependencies?.electron ?? require('../main/package.json').dependencies?.electron;
  assert.equal(electron, '43.8.3', 'Revalidate the embedded runtime allowance when Electron changes');
  assert.doesNotThrow(() => assertSupportedCliRuntime('24.22.0', '43.8.3'));
  for (const version of [undefined, '41.10.3', '43.8.1', '44.0.0']) {
    assert.throws(() => assertSupportedCliRuntime('24.22.0', version), { code: 'ERR_NODE_RUNTIME' });
  }
});
