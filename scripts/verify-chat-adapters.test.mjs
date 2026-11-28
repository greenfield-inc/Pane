// The after-pack check compares the bundled Agent Farm's plugin files with the installed package in
// both directions (PR #1740 review F-5): greenfield's plugin.yaml carries no checksums, so a file
// packing added would install into Pane's profiles unnoticed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { pluginInventoryDifference } = require('./verify-chat-adapters.js');

test('a packed plugin file the package lacks is reported as added', () => {
  const source = ['plugins/greenfield/plugin.yaml', 'plugins/greenfield/profiles/seo.yaml'];
  const packed = [...source, 'plugins/greenfield/profiles/extra.yaml'];
  assert.deepEqual(pluginInventoryDifference(packed, source), { missing: [], added: ['plugins/greenfield/profiles/extra.yaml'] });
});

test('a package file the archive lacks is reported as missing', () => {
  const source = ['plugins/greenfield/plugin.yaml', 'plugins/greenfield/profiles/seo.yaml'];
  assert.deepEqual(pluginInventoryDifference(['plugins/greenfield/plugin.yaml'], source), { missing: ['plugins/greenfield/profiles/seo.yaml'], added: [] });
});

test('matching inventories differ in nothing, whatever their order', () => {
  const source = ['plugins/greenfield/plugin.yaml', 'plugins/greenfield/profiles/seo.yaml'];
  assert.deepEqual(pluginInventoryDifference([...source].reverse(), source), { missing: [], added: [] });
});
