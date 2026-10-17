#!/usr/bin/env node
/**
 * Windows Build Script for Pane
 *
 * This script handles the complexities of building Pane on Windows,
 * particularly dealing with pnpm + node-gyp compatibility issues.
 *
 * Usage:
 *   node scripts/build-win.js [arch] [--publish]
 *
 * Arguments:
 *   arch      - Target architecture: 'x64' or 'arm64' (default: 'x64')
 *   --publish - Use '--publish always' instead of '--publish never' (for CI releases)
 *
 * What this script does:
 * 1. Patches winpty.gyp to fix batch file path issues on Windows
 * 2. Copies node-addon-api files to the expected pnpm location
 * 3. Downloads Electron-compatible prebuilts for the target architecture
 * 4. Builds frontend and main process
 * 5. Runs electron-builder with npmRebuild disabled (uses existing native modules)
 *
 * Known Issues & Workarounds:
 * - pnpm's nested node_modules structure causes node-gyp path resolution failures
 * - winpty build scripts use relative paths that don't work on Windows
 * - We skip npm rebuild and rely on the native modules built during `pnpm install`
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const os = require('os');

const { verifyPackedApp } = require('./verify-packaged-icon');

const ROOT_DIR = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(ROOT_DIR, 'node_modules');
const HOST_ARCH = os.arch(); // 'x64' or 'arm64'

// Parse command line arguments
const shouldPublish = process.argv.includes('--publish');
const args = process.argv.slice(2).filter(a => a !== '--publish');
const arch = args[0] || 'x64';
if (!['x64', 'arm64'].includes(arch)) {
  console.error('Invalid architecture. Use: x64 or arm64');
  process.exit(1);
}

console.log(`\n🔨 Building Pane for Windows ${arch} (host: ${HOST_ARCH})\n`);

/**
 * Execute a command and print output
 */
function run(cmd, options = {}) {
  console.log(`\n> ${cmd}\n`);
  try {
    execSync(cmd, {
      stdio: 'inherit',
      cwd: ROOT_DIR,
      shell: true,
      ...options
    });
  } catch (error) {
    if (!options.ignoreError) {
      console.error(`Command failed: ${cmd}`);
      process.exit(1);
    }
  }
}

/**
 * Patch winpty.gyp to fix batch file path issues
 *
 * The issue: winpty.gyp runs batch files like:
 *   cmd /c "cd shared && GetCommitHash.bat"
 *
 * On Windows, batch files need explicit .\ prefix to run from current directory.
 * This patches it to:
 *   cmd /c "cd shared && .\GetCommitHash.bat"
 */
function patchWinptyGyp() {
  console.log('📝 Patching winpty.gyp for Windows compatibility...');

  const winptyGypPath = path.join(
    NODE_MODULES,
    '.pnpm',
    '@homebridge+node-pty-prebuilt-multiarch@0.12.0',
    'node_modules',
    '@homebridge',
    'node-pty-prebuilt-multiarch',
    'deps',
    'winpty',
    'src',
    'winpty.gyp'
  );

  if (!fs.existsSync(winptyGypPath)) {
    console.log('  ⚠️  winpty.gyp not found, skipping patch');
    return;
  }

  let content = fs.readFileSync(winptyGypPath, 'utf8');
  let patched = false;

  // Patch GetCommitHash.bat call
  if (content.includes('cd shared && GetCommitHash.bat')) {
    content = content.replace(
      'cd shared && GetCommitHash.bat',
      'cd shared && .\\\\GetCommitHash.bat'
    );
    patched = true;
  }

  // Patch UpdateGenVersion.bat call
  if (content.includes('cd shared && UpdateGenVersion.bat')) {
    content = content.replace(
      'cd shared && UpdateGenVersion.bat',
      'cd shared && .\\\\UpdateGenVersion.bat'
    );
    patched = true;
  }

  if (patched) {
    fs.writeFileSync(winptyGypPath, content);
    console.log('  ✅ Patched winpty.gyp');
  } else {
    console.log('  ℹ️  winpty.gyp already patched or different version');
  }
}

/**
 * Copy node-addon-api to the location pnpm/node-gyp expects
 *
 * The issue: pnpm's nested structure puts node-addon-api in a different
 * location than node-gyp expects when resolving relative paths.
 */
function copyNodeAddonApi() {
  console.log('📦 Setting up node-addon-api for pnpm compatibility...');

  const sourceDir = path.join(
    NODE_MODULES,
    '.pnpm',
    'node-addon-api@7.1.1',
    'node_modules',
    'node-addon-api'
  );

  const targetDir = path.join(
    NODE_MODULES,
    '.pnpm',
    '@homebridge+node-pty-prebuilt-multiarch@0.12.0',
    'node-addon-api@7.1.1',
    'node_modules',
    'node-addon-api'
  );

  if (!fs.existsSync(sourceDir)) {
    console.log('  ⚠️  Source node-addon-api not found, skipping');
    return;
  }

  // Create target directory structure
  fs.mkdirSync(targetDir, { recursive: true });

  // Copy all files
  const files = fs.readdirSync(sourceDir);
  for (const file of files) {
    const srcPath = path.join(sourceDir, file);
    const destPath = path.join(targetDir, file);

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  console.log('  ✅ Copied node-addon-api files');
}

/**
 * Find the better-sqlite3-multiple-ciphers package directory
 */
function findBetterSqliteDir() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const expectedVersion = packageJson.dependencies?.['better-sqlite3-multiple-ciphers']?.replace(/^[~^]/, '');
  const betterSqlitePattern = path.join(
    NODE_MODULES,
    '.pnpm',
    'better-sqlite3-multiple-ciphers@*'
  );

  // Use glob to find the actual versioned directory
  const { globSync } = require('glob');
  const matches = globSync(betterSqlitePattern.replace(/\\/g, '/'));

  if (matches.length === 0) {
    return null;
  }

  const matchingVersion = expectedVersion
    ? matches.find(match => path.basename(match).startsWith(`better-sqlite3-multiple-ciphers@${expectedVersion}`))
    : undefined;
  const packageDir = matchingVersion || matches[0];

  return path.join(
    packageDir,
    'node_modules',
    'better-sqlite3-multiple-ciphers'
  );
}

/**
 * Download Electron-compatible prebuilt for better-sqlite3-multiple-ciphers for a specific architecture.
 *
 * The issue: When using `pnpm install --ignore-scripts` or when prebuild-install
 * runs without knowing about Electron, the wrong binary (Node.js ABI) gets installed.
 * This causes "is not a valid Win32 application" errors at runtime.
 *
 * This function runs prebuild-install with the correct Electron runtime and version.
 */
function downloadBetterSqlitePrebuiltForArch(targetArch) {
  console.log(`📥 Downloading Electron prebuilt for better-sqlite3-multiple-ciphers (${targetArch})...`);

  const betterSqliteDir = findBetterSqliteDir();

  if (!betterSqliteDir) {
    console.log('  ⚠️  better-sqlite3-multiple-ciphers not found, skipping');
    return;
  }

  if (!fs.existsSync(betterSqliteDir)) {
    console.log('  ⚠️  better-sqlite3-multiple-ciphers directory not found, skipping');
    return;
  }

  // Get Electron version from package.json
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const electronVersion = packageJson.devDependencies?.electron?.replace('^', '') || '41.10.3';

  console.log(`  📦 Electron version: ${electronVersion}, arch: ${targetArch}`);

  const isCrossCompiling = targetArch !== HOST_ARCH;

  try {
    execSync(
      `npx prebuild-install --runtime electron --target ${electronVersion} --platform win32 --arch ${targetArch} --verbose`,
      {
        cwd: betterSqliteDir,
        stdio: 'inherit',
        shell: true
      }
    );
    console.log(`  ✅ Downloaded Electron prebuilt for better-sqlite3 (${targetArch})`);
  } catch (error) {
    if (isCrossCompiling) {
      // When cross-compiling, we MUST have the correct arch binary - abort the build
      console.error(`  ❌ Failed to download ${targetArch} prebuilt for better-sqlite3.`);
      console.error(`     Host arch is ${HOST_ARCH} but target is ${targetArch} - cannot use existing binary.`);
      console.error(`     Error: ${error.message}`);
      process.exit(1);
    }
    // Same arch as host - the existing binary from pnpm install should work
    console.warn(`  ⚠️  Failed to download ${targetArch} prebuilt, using existing binary (host arch matches)`);
    console.warn(`     Error: ${error.message}`);
  }
}

/**
 * Install a cross-arch native module prebuilt for node-pty.
 *
 * pnpm only installs optional dependencies matching the host architecture.
 * For cross-arch builds, we need to manually install the target platform package
 * into the pnpm virtual store and create the appropriate symlinks so
 * electron-builder includes them in the packaged app.
 */
function installNodePtyForArch(targetArch) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const nodePtyVersion = packageJson.dependencies?.['@lydell/node-pty']?.replace(/^[~^]/, '');
  if (!nodePtyVersion) throw new Error('Missing @lydell/node-pty dependency version in package.json');
  const pkgName = `@lydell/node-pty-win32-${targetArch}`;
  const hoistedLink = path.join(NODE_MODULES, '@lydell', `node-pty-win32-${targetArch}`);

  if (fs.existsSync(hoistedLink)) {
    console.log(`  ℹ️  ${pkgName} already installed`);
    return;
  }

  console.log(`  📦 Installing ${pkgName}@${nodePtyVersion}...`);
  const tmpDir = path.join(ROOT_DIR, `tmp-${targetArch}`);

  try {
    // Download the tarball
    fs.mkdirSync(tmpDir, { recursive: true });
    const packDest = tmpDir.replace(/\\/g, '/');
    execSync(
      `npm pack ${pkgName}@${nodePtyVersion} --pack-destination "${packDest}"`,
      { cwd: ROOT_DIR, stdio: 'pipe', shell: true }
    );

    const tarballs = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      throw new Error('No tarball downloaded');
    }

    // Extract into pnpm virtual store structure
    const pnpmStoreDir = path.join(
      NODE_MODULES, '.pnpm',
      `@lydell+node-pty-win32-${targetArch}@${nodePtyVersion}`,
      'node_modules', '@lydell', `node-pty-win32-${targetArch}`
    );
    fs.mkdirSync(pnpmStoreDir, { recursive: true });

    // Use relative paths for tar — git bash tar on Windows can't handle C: prefix
    const tarballRel = path.relative(ROOT_DIR, path.join(tmpDir, tarballs[0])).replace(/\\/g, '/');
    const extractToRel = path.relative(ROOT_DIR, pnpmStoreDir).replace(/\\/g, '/');
    execSync(
      `tar -xzf "${tarballRel}" -C "${extractToRel}" --strip-components=1`,
      { cwd: ROOT_DIR, stdio: 'pipe', shell: true }
    );

    // Create hoisted symlink (junction on Windows, matching pnpm's structure)
    fs.mkdirSync(path.join(NODE_MODULES, '@lydell'), { recursive: true });
    fs.symlinkSync(pnpmStoreDir, hoistedLink, 'junction');

    console.log(`  ✅ Installed ${pkgName}`);
  } catch (error) {
    console.error(`  ❌ Failed to install ${targetArch} node-pty: ${error.message}`);
    throw error;
  } finally {
    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Main build process
 */
async function build() {
  console.log('🔧 Step 1: Applying Windows compatibility patches...\n');
  patchWinptyGyp();
  copyNodeAddonApi();
  downloadBetterSqlitePrebuiltForArch(arch);
  if (arch !== HOST_ARCH) {
    console.log(`📥 Installing ${arch} native module prebuilts (cross-arch from ${HOST_ARCH})...`);
    installNodePtyForArch(arch);
  }

  console.log('\n🔧 Step 2: Building frontend...\n');
  run('pnpm run build:frontend');

  console.log('\n🔧 Step 3: Building main process...\n');
  run('pnpm run build:main');

  console.log('\n🔧 Step 4: Injecting build info...\n');
  run('pnpm run inject-build-info');

  console.log('\n🔧 Step 5: Generating notices...\n');
  run('pnpm run generate-notices');

  console.log('\n🔧 Step 6: Running electron-builder...\n');

  const publishFlag = shouldPublish ? '--publish always' : '--publish never';
  run(`pnpm exec electron-builder --win --${arch} ${publishFlag} --config.npmRebuild=false`);

  // The launcher's icon is written by rcedit during the electron-builder run, so
  // this is the first point it can be checked. afterPack already covered the
  // runtime window icon.
  console.log('\n🔧 Step 7: Verifying packaged icons...\n');
  // electron-builder names the default arch's output win-unpacked and every
  // other arch win-<arch>-unpacked.
  const unpackedDir = [`win-${arch}-unpacked`, 'win-unpacked']
    .map((name) => path.join(ROOT_DIR, 'dist-electron', name))
    .find((candidate) => fs.existsSync(candidate));
  if (!unpackedDir) {
    console.error(`No packaged output directory for ${arch} under dist-electron.`);
    process.exit(1);
  }
  verifyPackedApp(unpackedDir, 'win32');

  console.log('\n✅ Build complete!\n');
  console.log('Output files are in: dist-electron/');

  // List output files
  const distDir = path.join(ROOT_DIR, 'dist-electron');
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir).filter(f => f.endsWith('.exe'));
    console.log('\nGenerated installers:');
    for (const file of files) {
      const stat = fs.statSync(path.join(distDir, file));
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      console.log(`  📦 ${file} (${sizeMB} MB)`);
    }
  }
}

// Run the build
build().catch(error => {
  console.error('Build failed:', error);
  process.exit(1);
});
