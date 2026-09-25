// Bundles the runpane CLI (including its MCP server) into one file that ships
// inside Pane, so `runpane mcp` works without a global npm install.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const runpaneDir = path.resolve(__dirname, '..', 'packages', 'runpane');
const outDir = path.join(__dirname, 'dist', 'runpane');

esbuild.buildSync({
  entryPoints: [path.join(runpaneDir, 'src', 'cli.ts')],
  outfile: path.join(outDir, 'dist', 'cli.js'),
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
});

// version.ts reads ../package.json next to dist/cli.js.
const { name, version } = require(path.join(runpaneDir, 'package.json'));
fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`);
console.log('Bundled runpane at', outDir);
