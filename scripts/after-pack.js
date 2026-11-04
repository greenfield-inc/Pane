const fs = require('fs');
const path = require('path');
const { Arch } = require('electron-builder');

const { verifyPackedApp } = require('./verify-packaged-icon');

function verifyLinuxSqliteArchitecture(appOutDir, arch) {
  const name = Arch[arch];
  const expected = { x64: 62, arm64: 183 }[name];
  if (!expected) throw new Error(`Unsupported Linux SQLite architecture: ${name}`);
  const file = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules',
    'better-sqlite3-multiple-ciphers', 'build', 'Release', 'better_sqlite3.node');
  const binary = fs.readFileSync(file);
  if (binary.length < 20 || binary.subarray(0, 4).toString() !== '\x7fELF'
    || binary[5] !== 1 || binary.readUInt16LE(18) !== expected) {
    throw new Error(`Packaged SQLite does not target Linux ${name}: ${file}`);
  }
  console.log(`[native-architecture] Packaged SQLite matches Linux ${name}`);
}

// Linux only: the package ships `pane`, and `Pane` is a compatibility alias for
// callers that still use the old capitalised name.
function createLinuxCompatibilityAlias(appOutDir) {
  const canonicalPath = path.join(appOutDir, 'pane');
  const aliasPath = path.join(appOutDir, 'Pane');
  if (!fs.existsSync(canonicalPath) || !fs.statSync(canonicalPath).isFile()) {
    throw new Error(`Cannot create Pane compatibility alias: ${canonicalPath} is missing.`);
  }
  try {
    const stat = fs.lstatSync(aliasPath);
    if (!stat.isSymbolicLink() || fs.readlinkSync(aliasPath) !== 'pane') {
      throw new Error(`Refusing to replace unexpected package output at ${aliasPath}.`);
    }
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.symlinkSync('pane', aliasPath);
}

async function afterPack(context) {
  // Runs for every platform and target, so a build that drops either the bundle
  // icon or the runtime window icon fails here instead of shipping (issue: the
  // v2.4.69 Windows taskbar icon). The Windows launcher's own icon is not
  // checked here — rcedit writes it after this hook — scripts/build-win.js
  // checks it once electron-builder has finished.
  verifyPackedApp(context.appOutDir, context.electronPlatformName, { checkExecutable: false });

  if (context.electronPlatformName !== 'linux') return;
  verifyLinuxSqliteArchitecture(context.appOutDir, context.arch);
  createLinuxCompatibilityAlias(context.appOutDir);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.afterPack = afterPack;
module.exports.createLinuxCompatibilityAlias = createLinuxCompatibilityAlias;
module.exports.verifyLinuxSqliteArchitecture = verifyLinuxSqliteArchitecture;
