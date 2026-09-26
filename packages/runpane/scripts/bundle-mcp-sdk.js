// Replaces tsc's dist/mcpSdk.js with an esbuild bundle of the MCP SDK so the
// published package keeps zero runtime dependencies.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const outfile = path.resolve(__dirname, '..', 'dist', 'mcpSdk.js');

esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'mcpSdk.ts')],
  outfile,
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'linked',
});
// tsc's source map describes the unbundled file.
fs.rmSync(`${outfile}.map`, { force: true });
