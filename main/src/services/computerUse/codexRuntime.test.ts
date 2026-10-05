import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateCodexRuntime } from './codexRuntime';

// Windows finds ChatGPT through its package registration, which the test supplies, so the lookup
// runs against a fake install on any OS.
describe('locating the Codex runtime', () => {
  let packageDir: string;
  let resources: string;

  function install(files: string[], manifest: typeof MANIFEST | null): void {
    const runtimeDir = path.join(resources, 'cua_node');
    fs.mkdirSync(runtimeDir, { recursive: true });
    if (manifest) fs.writeFileSync(path.join(runtimeDir, 'manifest.json'), JSON.stringify(manifest));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(resources, file)), { recursive: true });
      fs.writeFileSync(path.join(resources, file), '');
    }
  }

  const locate = () => locateCodexRuntime({ platform: 'win32', windowsPackageLocation: async () => packageDir });
  const MANIFEST = { node_path: 'bin/node.exe', node_repl_path: 'bin/node_repl.exe', node_modules: 'bin/node_modules', runtime_archive_version: '0.0.27/2026' };
  const FILES = ['cua_node/bin/node.exe', 'cua_node/bin/node_repl.exe', 'cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs', 'codex.exe'];

  beforeEach(() => {
    packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-'));
    resources = path.join(packageDir, 'app', 'resources');
  });

  afterEach(() => {
    fs.rmSync(packageDir, { recursive: true, force: true });
  });

  it('finds the launcher and its signed node from the runtime manifest', async () => {
    install(FILES, MANIFEST);

    const lookup = await locate();

    expect(lookup).toEqual({
      found: true,
      runtime: {
        platform: 'win32',
        resources,
        node: path.join(resources, 'cua_node/bin/node.exe'),
        nodeRepl: path.join(resources, 'cua_node/bin/node_repl.exe'),
        moduleDir: path.join(resources, 'cua_node/bin/node_modules'),
        launcher: path.join(resources, 'cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs'),
        codexCli: path.join(resources, 'codex.exe'),
        version: '0.0.27/2026',
      },
    });
  });

  it('says ChatGPT is not installed when no package is registered', async () => {
    await expect(locateCodexRuntime({ platform: 'win32', windowsPackageLocation: async () => null })).resolves.toEqual({
      found: false,
      reason: 'ChatGPT is not installed.',
    });
  });

  it('names the missing file when the install is incomplete', async () => {
    install(FILES.filter((file) => !file.endsWith('cua-repl.mjs')), MANIFEST);

    const lookup = await locate();

    expect(lookup.found).toBe(false);
    expect(!lookup.found && lookup.reason).toContain('cua-repl.mjs');
  });

  it('says so when ChatGPT has no computer-use runtime', async () => {
    install([], null);

    const lookup = await locate();

    expect(lookup.found).toBe(false);
    expect(!lookup.found && lookup.reason).toMatch(/no computer-use runtime/);
  });
});
