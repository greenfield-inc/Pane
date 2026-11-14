#!/usr/bin/env node
// Ships pane-relay (relay/) inside runpane the way esbuild ships its binary: one small npm package
// per platform, @runpane/relay-<platform>-<arch>, each limited by `os` and `cpu`, listed as runpane's
// optionalDependencies so npm installs only the matching one. `runpane relay`
// (packages/runpane/src/relay.ts) runs it. Every package takes runpane's version, so they move in lockstep.
//
//   build <platform> <outDir>     cargo build the release binary into <outDir>/<platform>/
//   stage <binariesDir> <outDir>  write every package from <binariesDir>/<platform>/ into <outDir>/<platform>/
//                                 and check that npm packs its binary, executable
//   pin                           list the packages npm has at runpane's version as its optionalDependencies
//                                 (the release does this just before it publishes runpane)
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNPANE_MANIFEST = path.join(ROOT, 'packages', 'runpane', 'package.json');

/** Rust target for each npm platform. Linux builds are static (musl), so one binary runs on any distribution. */
const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const packageName = (platform) => `@runpane/relay-${platform}`;
const binaryName = (platform) => (platform.startsWith('win32-') ? 'pane-relay.exe' : 'pane-relay');
const runpaneVersion = () => JSON.parse(fs.readFileSync(RUNPANE_MANIFEST, 'utf8')).version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function targetFor(platform) {
  const target = TARGETS[platform];
  if (!target) fail(`No relay package for "${platform}". Platforms: ${Object.keys(TARGETS).join(', ')}.`);
  return target;
}

function build(platform, outDir) {
  const target = targetFor(platform);
  execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' });
  // ring compiles C; musl-gcc (Debian/Ubuntu musl-tools) builds it against musl.
  const env = target.endsWith('-linux-musl') ? { ...process.env, [`CC_${target.replace(/-/g, '_')}`]: 'musl-gcc' } : process.env;
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(ROOT, 'relay', 'Cargo.toml'), '--target', target], { stdio: 'inherit', env });
  const targetDir = process.env.CARGO_TARGET_DIR || path.join(ROOT, 'relay', 'target');
  const binary = path.join(targetDir, target, 'release', binaryName(platform));
  const destination = path.join(outDir, platform, binaryName(platform));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(binary, destination);
  console.log(`Built ${destination}`);
}

function stage(binariesDir, outDir) {
  const version = runpaneVersion();
  const missing = Object.keys(TARGETS).filter((platform) => !fs.existsSync(path.join(binariesDir, platform, binaryName(platform))));
  if (missing.length > 0) fail(`No pane-relay binary for ${missing.join(', ')} in ${binariesDir}. Build each with: node scripts/runpane-relay-packages.js build <platform> ${binariesDir}`);
  for (const platform of Object.keys(TARGETS)) {
    const [os, cpu] = platform.split('-');
    const dir = path.join(outDir, platform);
    const bin = path.join(dir, 'bin', binaryName(platform));
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(path.join(binariesDir, platform, binaryName(platform)), bin);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
      name: packageName(platform),
      version,
      description: `The Pane relay (pane-relay) for ${os} ${cpu}. Run it with: npx runpane relay`,
      license: 'AGPL-3.0-only',
      homepage: 'https://runpane.com',
      repository: { type: 'git', url: 'git+https://github.com/greenfield-inc/Pane.git', directory: 'relay' },
      os: [os],
      cpu: [cpu],
      files: ['bin'],
      preferUnplugged: true,
      publishConfig: { access: 'public' },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${packageName(platform)}\n\nThe \`pane-relay\` binary for ${os} ${cpu}. Install \`runpane\` instead and run \`npx runpane relay\`; npm picks this package for you.\nSee [Run your own relay](https://github.com/greenfield-inc/Pane/blob/main/docs/SELF_HOSTED_RELAY.md).\n`);
    checkPack(dir, platform);
  }
}

/** npm must pack the binary, and keep it executable outside Windows. */
function checkPack(dir, platform) {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' }));
  const file = packed.files.find((entry) => entry.path === `bin/${binaryName(platform)}`);
  if (!file) fail(`${packed.name} would publish without bin/${binaryName(platform)}; npm packed: ${packed.files.map((entry) => entry.path).join(', ')}`);
  if (!platform.startsWith('win32-') && (file.mode & 0o111) === 0) fail(`${packed.name} would publish bin/${binaryName(platform)} without its executable bit (mode ${file.mode.toString(8)}).`);
  console.log(`${packed.id}: ${packed.files.length} files, ${packed.size} bytes packed`);
}

function onNpm(id) {
  try {
    execFileSync('npm', ['view', id, 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Lists only the packages npm has at this version, so runpane never names one npm lacks; on a
// platform whose package is missing, `runpane relay` says how to run the relay another way.
function pin() {
  const manifest = JSON.parse(fs.readFileSync(RUNPANE_MANIFEST, 'utf8'));
  const names = Object.keys(TARGETS).map((platform) => packageName(platform));
  const published = names.filter((name) => onNpm(`${name}@${manifest.version}`));
  for (const name of names.filter((n) => !published.includes(n))) {
    console.log(`::warning::${name}@${manifest.version} is not on npm, so runpane ${manifest.version} does not list it; runpane relay is unavailable on that platform.`);
  }
  manifest.optionalDependencies = Object.fromEntries(published.map((name) => [name, manifest.version]));
  fs.writeFileSync(RUNPANE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`runpane ${manifest.version} optionalDependencies: ${published.join(', ') || 'none'}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'build' && args.length === 2) build(...args);
else if (command === 'stage' && args.length === 2) stage(...args);
else if (command === 'pin' && args.length === 0) pin();
else fail('Usage: node scripts/runpane-relay-packages.js build <platform> <outDir> | stage <binariesDir> <outDir> | pin');
