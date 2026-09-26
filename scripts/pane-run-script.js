#!/usr/bin/env node

/**
 * pane-run-script.js
 *
 * Intelligent dev server launcher for Pane with git worktree support.
 *
 * Features:
 * - Auto-detects git worktrees vs main repo
 * - Assigns unique ports using hash(cwd) % 1000 + base_port
 * - Checks port availability, auto-increments if in use
 * - Auto-detects if deps need installing (package.json mtime > node_modules mtime)
 * - Auto-detects if build is stale (src mtime > dist mtime)
 * - Clean Ctrl+C termination (taskkill on Windows, SIGTERM on Unix)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');

const BASE_PORT = 4521;
const WORKTREE_PORT_OFFSET = 1000; // Worktrees start at 5521+
const MAX_PORT_ATTEMPTS = 100;

/**
 * Find the git root directory by traversing upwards
 */
function findGitRoot(dir) {
  let currentDir = dir;

  while (currentDir !== path.parse(currentDir).root) {
    const gitPath = path.join(currentDir, '.git');
    if (fs.existsSync(gitPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  throw new Error('Not in a git repository');
}

/**
 * Check if current directory is a git worktree
 */
function isWorktree(projectRoot) {
  const gitPath = path.join(projectRoot, '.git');

  if (!fs.existsSync(gitPath)) {
    return false;
  }

  const stats = fs.statSync(gitPath);

  // If .git is a file, this is a worktree
  if (stats.isFile()) {
    const gitContent = fs.readFileSync(gitPath, 'utf8');
    // Parse 'gitdir: path/to/main/repo/.git/worktrees/name'
    const match = gitContent.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate a unique port based on directory path hash
 * Main repo uses BASE_PORT (4521), worktrees use 5521-6520 range
 */
function calculatePort(dirPath, isWorktreeDir) {
  if (!isWorktreeDir) {
    // Main repo always uses BASE_PORT
    return BASE_PORT;
  }
  // Worktrees get a unique port in the 5521-6520 range
  const hash = crypto.createHash('md5').update(dirPath).digest('hex');
  const hashInt = parseInt(hash.substring(0, 8), 16);
  return BASE_PORT + WORKTREE_PORT_OFFSET + (hashInt % 1000);
}

/**
 * Check if a port is available
 */
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Find the next available port starting from the given port
 */
async function findNextAvailablePort(startPort) {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i;
    if (await checkPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find available port after ${MAX_PORT_ATTEMPTS} attempts`);
}

/**
 * Get the most recent modification time recursively
 */
function getMostRecentMtime(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  let maxMtime = 0;

  function traverse(currentPath) {
    const stats = fs.statSync(currentPath);

    if (stats.isFile()) {
      maxMtime = Math.max(maxMtime, stats.mtimeMs);
    } else if (stats.isDirectory()) {
      const entries = fs.readdirSync(currentPath);
      for (const entry of entries) {
        // Skip node_modules and .git
        if (entry === 'node_modules' || entry === '.git') {
          continue;
        }
        traverse(path.join(currentPath, entry));
      }
    }
  }

  traverse(dirPath);
  return maxMtime;
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall(root) {
  const nodeModulesPath = path.join(root, 'node_modules');
  const packageJsonPath = path.join(root, 'package.json');

  // If root node_modules doesn't exist, we need to install
  if (!fs.existsSync(nodeModulesPath)) {
    return true;
  }

  // pnpm workspaces: check that workspace node_modules also exist.
  // Git worktrees share source but not node_modules (gitignored), so the root
  // node_modules may exist from a prior partial install while workspace
  // subdirectories are missing.
  const workspaceDirs = ['frontend', 'main'];
  for (const dir of workspaceDirs) {
    if (!fs.existsSync(path.join(root, dir, 'node_modules'))) {
      return true;
    }
  }

  // Check if package.json is newer than node_modules
  const packageJsonStats = fs.statSync(packageJsonPath);
  const nodeModulesStats = fs.statSync(nodeModulesPath);

  return packageJsonStats.mtimeMs > nodeModulesStats.mtimeMs;
}

/**
 * Check if native modules need rebuilding for Electron
 * This checks if the better-sqlite3 binary exists and has a recent rebuild marker
 */
function needsNativeRebuild(root) {
  // Look for our rebuild marker file
  const markerPath = path.join(root, 'node_modules', '.electron-rebuild-marker');

  if (!fs.existsSync(markerPath)) {
    return true;
  }

  // Check if package.json changed since last rebuild
  const packageJsonPath = path.join(root, 'package.json');
  const packageJsonStats = fs.statSync(packageJsonPath);
  const markerStats = fs.statSync(markerPath);

  return packageJsonStats.mtimeMs > markerStats.mtimeMs;
}

/**
 * Create marker file after successful native rebuild
 */
function markNativeRebuildComplete(root) {
  const markerPath = path.join(root, 'node_modules', '.electron-rebuild-marker');
  fs.writeFileSync(markerPath, new Date().toISOString());
}

/**
 * Detect whether main/dist/main/src/preload.js is the esbuild bundle (safe for
 * the sandboxed preload) or the plain tsc emit, which still `require`s
 * ../../shared/... and fails to load inside the sandbox — leaving the renderer
 * without window.electronAPI and stuck on the browser fallback screen.
 */
function preloadIsBundled(root) {
  const preloadPath = path.join(root, 'main', 'dist', 'main', 'src', 'preload.js');
  if (!fs.existsSync(preloadPath)) return false;
  const source = fs.readFileSync(preloadPath, 'utf8');
  const runtimeRequires = [...source.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  return runtimeRequires.length > 0 && runtimeRequires.every((specifier) => specifier === 'electron');
}

/**
 * Re-run esbuild for the preload. `tsc -w` overwrites the bundle with a plain
 * emit on its initial pass and whenever preload.ts (or a shared import) changes.
 */
function bundlePreload(root) {
  console.log('[preload] Bundling sandboxed preload...');
  try {
    execSync('pnpm run --filter main bundle:preload', { cwd: root, stdio: 'inherit', shell: true });
    return true;
  } catch (error) {
    console.error('[preload] ❌ Failed to bundle preload; the renderer will fall back to browser mode until this is fixed.');
    return false;
  }
}

/**
 * Watch the tsc output directory and re-bundle whenever tsc drops an
 * unbundled preload.js there.
 */
function watchPreloadEmit(root) {
  const distDir = path.join(root, 'main', 'dist', 'main', 'src');
  if (!fs.existsSync(distDir)) return null;
  let timer = null;
  let bundling = false;
  const check = () => {
    timer = null;
    if (bundling || preloadIsBundled(root)) return;
    bundling = true;
    try {
      bundlePreload(root);
    } finally {
      bundling = false;
    }
  };
  try {
    const watcher = fs.watch(distDir, (_event, filename) => {
      if (filename && String(filename) !== 'preload.js') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 500);
    });
    watcher.on('error', () => {});
    return watcher;
  } catch (error) {
    console.warn(`[preload] Could not watch ${distDir}: ${error.message}`);
    return null;
  }
}

/**
 * Check if build is needed
 */
function needsBuild(root) {
  const distPath = path.join(root, 'main', 'dist');
  const srcPath = path.join(root, 'main', 'src');

  // If dist doesn't exist, we need to build
  if (!fs.existsSync(distPath)) {
    return true;
  }

  // Get most recent source file modification time
  const srcMtime = getMostRecentMtime(srcPath);
  const distMtime = getMostRecentMtime(distPath);

  return srcMtime > distMtime;
}

/**
 * Execute a command with proper error handling
 */
function execCommand(command, cwd) {
  console.log(`\n📦 Running: ${command}`);
  try {
    execSync(command, {
      cwd,
      stdio: 'inherit',
      shell: true
    });
  } catch (error) {
    console.error(`❌ Command failed: ${command}`);
    process.exit(1);
  }
}

/**
 * Kill process tree on Windows
 */
function killProcessWindows(pid) {
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
  } catch (error) {
    // Ignore errors - process might already be dead
  }
}

/**
 * Kill process tree on Unix
 */
function killProcessUnix(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    // Ignore errors - process might already be dead
  }
}

/**
 * Main execution
 */
async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const unknownArgs = args.filter(arg => arg !== '--react-scan');
  if (unknownArgs.length > 0) {
    console.error(`❌ Unknown argument(s): ${unknownArgs.join(', ')}`);
    process.exit(1);
  }
  const reactScanEnabled = args.includes('--react-scan');

  console.log('🚀 pane-run-script.js starting...\n');

  // Find git root
  let projectRoot;
  try {
    projectRoot = findGitRoot(cwd);
    console.log(`📁 Project root: ${projectRoot}`);
  } catch (error) {
    console.error('❌ Error: Not in a git repository');
    process.exit(1);
  }

  // Check if this is a worktree
  const worktree = isWorktree(projectRoot);
  console.log(`🌲 Git worktree: ${worktree ? 'YES' : 'NO (main repo)'}`);

  // Explicit ports are used by Playwright and existing electron-dev callers.
  const configuredPort = process.env.VITE_PORT || process.env.PORT;
  let port = configuredPort ? Number(configuredPort) : calculatePort(projectRoot, worktree);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid dev server port: ${configuredPort}`);
  }
  console.log(`🔢 Calculated port: ${port}${worktree ? ' (worktree range)' : ' (main repo)'}`);

  // Check port availability
  const portAvailable = await checkPortAvailable(port);
  if (!portAvailable) {
    if (configuredPort) throw new Error(`Configured dev server port ${port} is in use.`);
    console.log(`⚠️  Port ${port} is in use, finding next available...`);
    port = await findNextAvailablePort(port);
    console.log(`✅ Using port: ${port}`);
  } else {
    console.log(`✅ Port ${port} is available`);
  }

  // Check if we need to install dependencies
  if (needsInstall(projectRoot)) {
    console.log('\n📦 Dependencies out of date, installing...');
    execCommand('pnpm install', projectRoot);

    // Rebuild native modules for Electron (critical for better-sqlite3, node-pty, etc.)
    console.log('\n🔧 Rebuilding native modules for Electron...');
    execCommand('npx @electron/rebuild -f -w better-sqlite3-multiple-ciphers', projectRoot);
    markNativeRebuildComplete(projectRoot);
  } else if (needsNativeRebuild(projectRoot)) {
    // Dependencies are installed but native modules need rebuild
    console.log('\n🔧 Native modules need rebuilding for Electron...');
    execCommand('npx @electron/rebuild -f -w better-sqlite3-multiple-ciphers', projectRoot);
    markNativeRebuildComplete(projectRoot);
  } else {
    console.log('\n✅ Dependencies and native modules up to date');
  }

  // Check if we need to build
  if (needsBuild(projectRoot)) {
    console.log('\n🔨 Build out of date, building main process...');
    execCommand('pnpm build:main', projectRoot);
  } else {
    console.log('\n✅ Build up to date');
  }

  // Set up environment
  const env = {
    ...process.env,
    PORT: port.toString(),
    VITE_PORT: port.toString()
  };

  if (reactScanEnabled) {
    env.PANE_REACT_SCAN = '1';
    console.log('🔬 React Scan render evidence enabled for this dev session');
  }

  console.log('\n🎬 Starting dev server...\n');
  console.log('─'.repeat(50));

  const isWindows = process.platform === 'win32';
  const children = [];

  // 1. Start TypeScript watcher for main process
  // stdout is piped (and mirrored) so we can tell when tsc's initial emit has
  // landed: it overwrites the bundled preload.js, and Electron must not load
  // the window until that emit has been re-bundled.
  const tscWatch = spawn('pnpm', ['run', '--filter', 'main', 'dev'], {
    cwd: projectRoot,
    env,
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: true
  });
  children.push(tscWatch);
  console.log('[tsc] TypeScript watch started');

  const tscInitialEmit = new Promise((resolve) => {
    let settled = false;
    tscWatch.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (!settled && /Watching for file changes/.test(chunk.toString())) {
        settled = true;
        resolve();
      }
    });
    tscWatch.on('exit', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });

  // 2. Start Vite dev server with the correct port
  const vite = spawn('pnpm', ['run', '--filter', 'frontend', 'dev', '--', '--port', port.toString()], {
    cwd: projectRoot,
    env,
    detached: !isWindows,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: true
  });
  children.push(vite);
  console.log(`[vite] Frontend dev server starting on port ${port}`);

  // 3. Wait for Vite and tsc's initial emit, re-bundle the preload that emit
  //    just clobbered, then launch Electron.
  const waitOn = spawn('npx', ['wait-on', `http-get://localhost:${port}`], {
    cwd: projectRoot,
    env,
    detached: !isWindows,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: true
  });
  children.push(waitOn);
  console.log(`[electron] Waiting for http-get://localhost:${port} and the main-process build, then launching Electron`);

  const viteReady = new Promise((resolve, reject) => {
    waitOn.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wait-on exited with code ${code}`))));
  });

  let electron = null;
  const preloadWatcher = watchPreloadEmit(projectRoot);
  Promise.all([viteReady, tscInitialEmit])
    .then(() => {
      if (!preloadIsBundled(projectRoot)) {
        bundlePreload(projectRoot);
      }
      electron = spawn('npx', ['electron', '.'], {
        cwd: projectRoot,
        env,
        detached: !isWindows,
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: true
      });
      children.push(electron);
      electron.on('exit', (code) => {
        console.log(`\n📋 Electron exited with code ${code}`);
        cleanup();
      });
    })
    .catch((error) => {
      console.error(`\n❌ ${error.message}`);
      cleanup();
    });

  // Handle cleanup on exit
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.log('\n\n🛑 Shutting down dev server...');
    if (preloadWatcher) preloadWatcher.close();

    for (const child of children) {
      if (child.pid) {
        if (isWindows) {
          killProcessWindows(child.pid);
        } else {
          killProcessUnix(child.pid);
        }
      }
    }

    process.exit(0);
  };

  // Register cleanup handlers
  process.on('SIGINT', cleanup);  // Ctrl+C
  process.on('SIGTERM', cleanup); // Kill command
  process.on('SIGHUP', cleanup);  // Terminal or Pane panel closed

  // If any critical process exits, shut everything down
  vite.on('exit', (code) => {
    if (code !== 0) {
      console.log(`\n📋 Vite exited with code ${code}`);
      cleanup();
    }
  });
}

// Run the script
main().catch((error) => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
