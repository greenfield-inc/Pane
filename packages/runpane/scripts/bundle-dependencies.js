// Bundles the MCP SDK and terminal prompts so the
// published package keeps zero runtime dependencies.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

for (const entry of ['mcpSdk', 'setupPrompts']) {
  const outfile = path.resolve(__dirname, '..', 'dist', `${entry}.js`);

  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '..', 'src', `${entry}.ts`)],
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
}
