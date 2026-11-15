const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'direct', 'Cargo.toml');

/** Rust targets for each platform and Electron arch Pane packages. */
const TARGETS = {
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

function hasCommand(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the `pane-direct` helper (direct/) in release mode for one packaged platform and arch,
 * and returns the binary's path. Needs Rust (https://rustup.rs).
 */
function buildPaneDirect(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`pane-direct has no Rust target for ${platform} ${arch}, so the package was not built. Add it to TARGETS in scripts/build-pane-direct.js.`);
  if (!hasCommand('cargo')) {
    throw new Error('Packaging Pane builds the pane-direct helper with Rust, and cargo is not on PATH, so the package was not built. '
      + 'Install Rust from https://rustup.rs, then build again.');
  }
  if (hasCommand('rustup')) execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' });
  console.log(`[pane-direct] Building for ${target}`);
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', MANIFEST, '--target', target], { stdio: 'inherit' });
  const binary = path.join(ROOT, 'direct', 'target', target, 'release', platform === 'win32' ? 'pane-direct.exe' : 'pane-direct');
  if (!fs.existsSync(binary)) throw new Error(`cargo finished without producing ${binary}, so the package was not built. Run the cargo command above by hand to see why.`);
  return binary;
}

module.exports = { buildPaneDirect, hasCommand };

if (require.main === module) {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
  console.log(buildPaneDirect(platform, arch));
}
