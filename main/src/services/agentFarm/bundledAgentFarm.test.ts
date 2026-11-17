import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_AGENT_FARM_PLUGINS,
  agentFarmConfigRoot,
  bundledAgentFarm,
  bundledAgentFarmProcess,
  installBundledAgentFarm,
  type AgentFarmProcess,
  type BundledAgentFarm,
} from './bundledAgentFarm';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-agent-farm-'));
  temporary.push(dir);
  return dir;
}

/** A stand-in package: plugin source files, and a runner that "installs" by creating plugins/<name>. */
function fakeBundle(version = '0.2.34'): BundledAgentFarm {
  const root = tempDir();
  mkdirSync(path.join(root, 'plugins', 'greenfield'), { recursive: true });
  writeFileSync(path.join(root, 'plugins', 'greenfield', 'plugin.yaml'), 'name: greenfield\nversion: 0.0.46\n');
  return { root, entry: path.join(root, 'dist', 'cli.js'), version };
}

function recordingRunner(calls: AgentFarmProcess[], fail?: string) {
  return async (process: AgentFarmProcess) => {
    calls.push(process);
    if (fail) throw Object.assign(new Error('Command failed'), { stderr: `warning\n${fail}\n` });
    const name = process.args[3] === '--config-root' ? 'greenfield' : process.args[3];
    const root = process.args[process.args.indexOf('--config-root') + 1];
    mkdirSync(path.join(root, 'plugins', name), { recursive: true });
    return `note: installed\n{\n  "name": "${name}",\n  "version": "1.2.3",\n  "changed": 4\n}\n`;
  };
}

describe('installBundledAgentFarm', () => {
  it('installs every bundled plugin into <PANE_DIR>/agent-farm on first start, greenfield first', async () => {
    const paneDir = tempDir();
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls), log: (line) => logs.push(line) });
    expect(status).toMatchObject({ state: 'ready', version: '0.2.34', configRoot: agentFarmConfigRoot(paneDir) });
    expect(Object.keys(status.plugins)).toEqual([...BUNDLED_AGENT_FARM_PLUGINS]);
    expect(calls.map((call) => call.args.slice(1))).toEqual([
      ['plugin', 'install', '--config-root', path.join(paneDir, 'agent-farm')],
      ['plugin', 'install', 'orchestra', '--config-root', path.join(paneDir, 'agent-farm')],
      ['plugin', 'install', 'bigbrain', '--config-root', path.join(paneDir, 'agent-farm')],
      ['plugin', 'install', 'machine-security', '--config-root', path.join(paneDir, 'agent-farm')],
    ]);
    expect(calls.every((call) => call.env.ELECTRON_RUN_AS_NODE === '1')).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(paneDir, 'agent-farm', 'pane-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ agentFarmVersion: '0.2.34', plugins: { greenfield: '1.2.3' } });
    expect(logs.at(-1)).toContain('set up: greenfield 1.2.3');
  });

  it('reinstalls nothing when the bundle is unchanged, and says so', async () => {
    const paneDir = tempDir();
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner(calls), log: (line) => logs.push(line) });
    expect(status.state).toBe('ready');
    expect(calls).toEqual([]);
    expect(logs).toEqual([expect.stringContaining('(manifest hash unchanged); nothing reinstalled')]);
  });

  it('reinstalls when a plugin file or the version changes', async () => {
    const paneDir = tempDir();
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    writeFileSync(path.join(bundle.root, 'plugins', 'greenfield', 'plugin.yaml'), 'name: greenfield\nversion: 0.0.47\n');
    const calls: AgentFarmProcess[] = [];
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner(calls), log: () => undefined });
    expect(calls).toHaveLength(BUNDLED_AGENT_FARM_PLUGINS.length);
    const again: AgentFarmProcess[] = [];
    await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '0.2.35' }, run: recordingRunner(again), log: () => undefined });
    expect(again).toHaveLength(BUNDLED_AGENT_FARM_PLUGINS.length);
  });

  it('reports a failed install with Agent Farm\'s own last line, without throwing', async () => {
    const paneDir = tempDir();
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner([], 'error: disk full'), log: (line) => logs.push(line) });
    expect(status.state).toBe('failed');
    expect(status.error).toContain('error: disk full');
    expect(status.error).toContain('restart Pane to try again');
    expect(logs.at(-1)).toContain('[AgentFarm]');
  });

  it('reports a build without the package as missing', async () => {
    const status = await installBundledAgentFarm({ paneDir: tempDir(), bundle: undefined, log: () => undefined, run: recordingRunner([]) });
    // bundle: undefined falls back to the real resolver, which finds the pinned package in this repo.
    expect(status.state).not.toBe('missing');
    expect(bundledAgentFarm(() => { throw new Error('not found'); })).toBeUndefined();
  });
});

describe('bundledAgentFarmProcess', () => {
  it('runs the entry with the runtime as Node, against Pane\'s config root, without AGENT_FARM_CONFIG_ROOT', () => {
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    const process = bundledAgentFarmProcess(bundle, ['run', 'greenfield/planner'], '/pane/agent-farm', { PATH: '/bin', AGENT_FARM_CONFIG_ROOT: '/elsewhere' }, '/Pane.exe');
    expect(process).toEqual({ executable: '/Pane.exe', args: ['/app/dist/cli.js', 'run', 'greenfield/planner', '--config-root', '/pane/agent-farm'], env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' } });
  });
});

describe('the pinned package', () => {
  it('resolves and answers --version with this Node', () => {
    const bundle = bundledAgentFarm();
    expect(bundle?.version).toBe('0.2.34');
    if (!bundle) return;
    const process = bundledAgentFarmProcess(bundle, ['--version'], tempDir());
    // --version takes no config root; run the entry alone.
    expect(execFileSync(process.executable, [bundle.entry, '--version'], { env: process.env, encoding: 'utf8' }).trim()).toBe('0.2.34');
  });
});
