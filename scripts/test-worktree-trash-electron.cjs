// Run with Node: node scripts/test-worktree-trash-electron.cjs
// Uses a real Electron main process: plain Node cannot expose ASAR self-locking.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-asar-regression-'));
  const env = { ...process.env, PANE_DIR: path.join(root, 'pane-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawnSync(require('electron'), [__filename, root], {
      env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    process.stdout.write(child.stdout);
  } finally {
    // spawnSync has waited for child exit before cleanup; never race its rm.
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('pane-asar-regression-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  const fs = require('original-fs');
  const { app } = require('electron');
  const Module = require('node:module');
  const ts = require('typescript');
  const root = process.argv[2];
  app.setPath('userData', path.join(root, 'profile'));
  app.disableHardwareAcceleration();

  // Load the service without building or changing the app/native SQLite ABI.
  function loadTs(filename) {
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = id => {
      if (id.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), `${id}.ts`);
        if (fs.existsSync(target)) return loadTs(target);
      }
      return originalRequire(id);
    };
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText, filename);
    return loaded.exports;
  }

  (async () => {
    const { sweepWorktreeTrash } = loadTs(path.resolve(__dirname, '../main/src/services/worktreeTrash.ts'));
    const common = path.join(root, 'common');
    const trash = path.join(common, 'pane-trash', 'dependency');
    fs.mkdirSync(trash, { recursive: true });
    fs.copyFileSync(path.join(process.resourcesPath, 'default_app.asar'), path.join(trash, 'default_app.asar'));
    const sentinel = path.join(root, 'keep.txt');
    fs.writeFileSync(sentinel, 'preserved');
    const noAsar = process.noAsar;
    await sweepWorktreeTrash(root, { environment: 'native' }, {
      execFile: async () => ({ stdout: common, stderr: '', exitCode: 0 }),
    });
    assert.equal(fs.existsSync(trash), false, 'Electron trash sweep must delete physical ASAR files');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserved');
    assert.equal(process.noAsar, noAsar, 'must not toggle process-wide ASAR behavior');
    console.log(`PASS worktree trash ASAR regression (Electron ${process.versions.electron}, ${process.platform})`);
    app.exit(0);
  })().catch(error => {
    console.error(error);
    app.exit(1);
  });
}
