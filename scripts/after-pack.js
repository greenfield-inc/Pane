const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Arch } = require('electron-builder');

const { verifyPackedApp } = require('./verify-packaged-icon');
const { verifyChatAdapters } = require('./verify-chat-adapters');

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

// AVX (VEX-encoded `v*` instructions) and BMI1/BMI2 need CPUs newer than the
// generic x86-64 baseline. SQLite3 Multiple Ciphers compiles its AEGIS cipher
// for several CPU levels and picks one at runtime, so only `aegis` functions
// may use them (issue #1226).
const NEWER_CPU_INSTRUCTION = /^(v[a-z]|(andn|bextr|blsi|blsmsk|blsr|bzhi|mulx|pdep|pext|rorx|sarx|shlx|shrx)[lq]?$)/;
const RUNTIME_DISPATCHED_FUNCTION = /aegis/i;

function functionsNeedingNewerX64Cpu(file) {
  const disassembly = execFileSync('objdump', ['-d', '--no-show-raw-insn', file],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  const offenders = new Set();
  let currentFunction = '';
  for (const line of disassembly.split('\n')) {
    const header = /^[0-9a-f]+ <(.+)>:$/.exec(line);
    if (header) {
      currentFunction = header[1];
      continue;
    }
    const mnemonic = line.split('\t')[1]?.trim().split(/\s/)[0];
    if (mnemonic && NEWER_CPU_INSTRUCTION.test(mnemonic)
      && !RUNTIME_DISPATCHED_FUNCTION.test(currentFunction)) {
      offenders.add(currentFunction);
    }
  }
  return [...offenders];
}

function nativeModulesBuiltFromSource(directory) {
  return fs.readdirSync(directory, { recursive: true })
    .filter((entry) => entry.endsWith('.node') && entry.split(path.sep).includes('build'))
    .map((entry) => path.join(directory, entry));
}

function verifyLinuxX64Baseline(appOutDir) {
  const modules = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  for (const file of nativeModulesBuiltFromSource(modules)) {
    const offenders = functionsNeedingNewerX64Cpu(file);
    if (offenders.length > 0) {
      throw new Error(`${file} uses AVX or BMI instructions outside runtime CPU dispatch, `
        + `so it crashes with SIGILL on older x86-64 CPUs. Rebuild it with `
        + `CFLAGS/CXXFLAGS='-march=x86-64 -mtune=generic'. Functions: ${offenders.slice(0, 10).join(', ')}`);
    }
    console.log(`[native-baseline] ${path.relative(modules, file)} targets generic x86-64`);
  }
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
  // Chat tabs run the bundled ACP adapters; a build that cannot start them fails here.
  await verifyChatAdapters(context.appOutDir, context.electronPlatformName, Arch[context.arch]);

  if (context.electronPlatformName !== 'linux') return;
  verifyLinuxSqliteArchitecture(context.appOutDir, context.arch);
  if (Arch[context.arch] === 'x64') verifyLinuxX64Baseline(context.appOutDir);
  createLinuxCompatibilityAlias(context.appOutDir);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.afterPack = afterPack;
module.exports.createLinuxCompatibilityAlias = createLinuxCompatibilityAlias;
module.exports.verifyLinuxSqliteArchitecture = verifyLinuxSqliteArchitecture;
