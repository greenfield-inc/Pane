#!/usr/bin/env node
// Copies the built runpane CLI into plugins/pane/server so the ChatGPT plugin runs its own
// `runpane mcp` over stdio. Run `pnpm build:chatgpt-plugin`, which builds runpane first.
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const runpaneDir = path.join(rootDir, 'packages', 'runpane');
const serverDir = path.join(rootDir, 'plugins', 'pane', 'server');
const { version } = JSON.parse(fs.readFileSync(path.join(runpaneDir, 'package.json'), 'utf8'));

fs.rmSync(serverDir, { recursive: true, force: true });
fs.cpSync(path.join(runpaneDir, 'dist'), path.join(serverDir, 'dist'), {
  recursive: true,
  filter: (source) => !/\.(map|d\.ts)$/.test(source),
});
// The CLI reads its version from the package.json beside dist/.
fs.writeFileSync(path.join(serverDir, 'package.json'), `${JSON.stringify({ name: 'runpane', version, private: true }, null, 2)}\n`);
console.log(`Bundled runpane ${version} into ${path.relative(rootDir, serverDir)}`);
