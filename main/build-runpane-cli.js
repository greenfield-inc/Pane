// Bundles the runpane CLI into one file that ships with Pane. At startup Pane
// copies it to <PANE_DIR>/bin and puts a `runpane` shim first on terminal
// PATH (see src/services/runpaneShim.ts), so agents always get the CLI that
// matches this build instead of a global install.
const path = require('path');
const esbuild = require('esbuild');
const { version } = require('../packages/runpane/package.json');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'packages', 'runpane', 'src', 'cli.ts')],
  outfile: path.join(__dirname, 'dist', 'runpane', 'runpane.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // The bundle has no package.json beside it to read the version from.
  define: { 'process.env.RUNPANE_BUNDLED_VERSION': JSON.stringify(version) },
  logLevel: 'warning',
});
console.log(`Bundled runpane ${version} -> dist/runpane/runpane.cjs`);
