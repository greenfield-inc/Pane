import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_AGENT_FARM_PLUGINS,
  RETIRED_AGENT_FARM_PLUGINS,
  agentFarmConfigRoot,
  bundledAgentFarm,
  bundledAgentFarmProcess,
  installBundledAgentFarm,
  paneAgentFarmProcess,
  writeAgentFarmTelemetry,
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

function recordingRunner(calls: AgentFarmProcess[], fail?: string, failUninstall?: string) {
  return async (process: AgentFarmProcess) => {
    calls.push(process);
    const root = process.args[process.args.indexOf('--config-root') + 1];
    if (process.args[2] === 'uninstall') {
      if (failUninstall) throw Object.assign(new Error('Command failed'), { stderr: `warning\n${failUninstall}\n` });
      const name = process.args[3];
      rmSync(path.join(root, 'plugins', name), { recursive: true, force: true });
      rmSync(path.join(root, '.plugins', `${name}.json`), { force: true });
      return `{\n  "name": "${name}",\n  "removed": ["a.md", "b.md"],\n  "stayed": [{ "file": "c.md", "reason": "modified" }]\n}\n`;
    }
    if (fail) throw Object.assign(new Error('Command failed'), { stderr: `warning\n${fail}\n` });
    const name = process.args[3] === '--config-root' ? 'greenfield' : process.args[3];
    mkdirSync(path.join(root, 'plugins', name), { recursive: true });
    return `note: installed\n{\n  "name": "${name}",\n  "version": "1.2.3",\n  "changed": 4\n}\n`;
  };
}

/** What an older Pane left in its config root: a retired plugin's files and Agent Farm's receipt for them. */
function installRetired(paneDir: string, name: string): void {
  const configRoot = agentFarmConfigRoot(paneDir);
  mkdirSync(path.join(configRoot, 'plugins', name), { recursive: true });
  mkdirSync(path.join(configRoot, '.plugins'), { recursive: true });
  writeFileSync(path.join(configRoot, '.plugins', `${name}.json`), '{"layout":2}');
}

describe('installBundledAgentFarm', () => {
  it('bundles greenfield alone and retires dcouple and bigbrain', () => {
    expect([...BUNDLED_AGENT_FARM_PLUGINS]).toEqual(['greenfield']);
    expect([...RETIRED_AGENT_FARM_PLUGINS]).toEqual(['dcouple', 'bigbrain']);
  });

  it('installs only greenfield into <PANE_DIR>/agent-farm on first start, and uninstalls nothing that is absent', async () => {
    const paneDir = tempDir();
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls), log: (line) => logs.push(line) });
    expect(status).toMatchObject({ state: 'ready', version: '0.2.34', configRoot: agentFarmConfigRoot(paneDir) });
    expect(Object.keys(status.plugins)).toEqual([...BUNDLED_AGENT_FARM_PLUGINS]);
    expect(calls.map((call) => call.args.slice(1))).toEqual([
      ['plugin', 'install', '--config-root', path.join(paneDir, 'agent-farm')],
    ]);
    expect(calls.every((call) => call.env.ELECTRON_RUN_AS_NODE === '1')).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(paneDir, 'agent-farm', 'pane-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ agentFarmVersion: '0.2.34', plugins: { greenfield: '1.2.3' } });
    expect(logs.at(-1)).toContain('set up: greenfield 1.2.3');
  });

  it('uninstalls retired plugins an older Pane installed, and drops them from the manifest', async () => {
    const paneDir = tempDir();
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    // An older Pane with the same Agent Farm version also installed dcouple, and bigbrain came from before that.
    const manifestPath = path.join(agentFarmConfigRoot(paneDir), 'pane-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, plugins: { ...manifest.plugins, dcouple: '0.1.29' } }));
    installRetired(paneDir, 'dcouple');
    installRetired(paneDir, 'bigbrain');
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner(calls), log: (line) => logs.push(line) });
    // The bundle is unchanged, so greenfield is left as it is; only the manifest is rewritten.
    expect(calls.map((call) => call.args.slice(1, 4))).toEqual([
      ['plugin', 'uninstall', 'dcouple'],
      ['plugin', 'uninstall', 'bigbrain'],
    ]);
    expect(status).toMatchObject({ state: 'ready', plugins: { greenfield: '1.2.3' } });
    expect(Object.keys(status.plugins)).toEqual(['greenfield']);
    expect(Object.keys(JSON.parse(readFileSync(manifestPath, 'utf8')).plugins)).toEqual(['greenfield']);
    expect(logs).toContainEqual(expect.stringContaining('Uninstalled retired plugin dcouple: removed 2 files, left 1 changed file in place (c.md).'));
    expect(logs).toContainEqual(expect.stringContaining('Uninstalled retired plugin bigbrain'));
    // Idempotent: the next start finds nothing to retire and nothing to reinstall.
    const again: AgentFarmProcess[] = [];
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner(again), log: () => undefined });
    expect(again).toEqual([]);
  });

  it('keeps greenfield\'s local files when an unchanged bundle only drops a retired plugin from the manifest', async () => {
    const paneDir = tempDir();
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    const configRoot = agentFarmConfigRoot(paneDir);
    const local = path.join(configRoot, 'plugins', 'greenfield', 'profiles', 'mine.yaml');
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, 'name: mine\n');
    const manifestPath = path.join(configRoot, 'pane-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, plugins: { ...manifest.plugins, dcouple: '0.1.29' } }));
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner(calls), log: (line) => logs.push(line) });
    expect(calls).toEqual([]);
    expect(readFileSync(local, 'utf8')).toBe('name: mine\n');
    expect(status).toMatchObject({ state: 'ready', plugins: { greenfield: '1.2.3' } });
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({ ...manifest, plugins: { greenfield: '1.2.3' } });
    expect(logs).toContainEqual(expect.stringContaining('dropped dcouple from the manifest'));
  });

  it('moves an unreadable retired receipt aside, keeping its bytes and files, and still installs greenfield', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    installRetired(paneDir, 'dcouple');
    writeFileSync(path.join(configRoot, '.plugins', 'dcouple.json'), '{"layout":2,');
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls), log: (line) => logs.push(line) });
    expect(status).toMatchObject({ state: 'ready', plugins: { greenfield: '1.2.3' } });
    expect(calls.map((call) => call.args.slice(1, 3))).toEqual([['plugin', 'install']]);
    const aside = readdirSync(path.join(configRoot, '.plugins')).filter((file) => file.startsWith('dcouple'));
    expect(aside).toHaveLength(1);
    expect(aside[0].endsWith('.json')).toBe(false);
    expect(readFileSync(path.join(configRoot, '.plugins', aside[0]), 'utf8')).toBe('{"layout":2,');
    expect(existsSync(path.join(configRoot, 'plugins', 'dcouple'))).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining(`moved it aside to ${path.join(configRoot, '.plugins', aside[0])}`));
  });

  it('logs a failed uninstall and still installs greenfield', async () => {
    const paneDir = tempDir();
    installRetired(paneDir, 'dcouple');
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls, undefined, 'error: permission denied'), log: (line) => logs.push(line) });
    expect(status).toMatchObject({ state: 'ready', plugins: { greenfield: '1.2.3' } });
    expect(calls.map((call) => call.args.slice(1, 3))).toEqual([['plugin', 'uninstall'], ['plugin', 'install']]);
    expect(logs).toContainEqual(expect.stringContaining("Pane couldn't uninstall the retired Agent Farm plugin dcouple"));
    expect(logs).toContainEqual(expect.stringContaining('error: permission denied'));
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
    expect(process).toEqual({ executable: '/Pane.exe', args: ['/app/dist/cli.js', 'run', 'greenfield/planner', '--config-root', '/pane/agent-farm'], env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', AGENT_FARM_TELEMETRY: 'off' } });
  });

  // A repository's .agent-farm/workspace.yaml outranks settings.json; only AGENT_FARM_TELEMETRY outranks it.
  it('turns telemetry off for the launch unless Pane\'s switch is on, keeping a value already set', async () => {
    const paneDir = tempDir();
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    const env = () => bundledAgentFarmProcess(bundle, ['run', 'p'], agentFarmConfigRoot(paneDir), { PATH: '/bin' }).env.AGENT_FARM_TELEMETRY;
    expect(env()).toBe('off');
    await writeAgentFarmTelemetry(paneDir, false);
    expect(env()).toBe('off');
    await writeAgentFarmTelemetry(paneDir, true);
    expect(env()).toBeUndefined();
    await writeAgentFarmTelemetry(paneDir, false);
    expect(bundledAgentFarmProcess(bundle, ['run', 'p'], agentFarmConfigRoot(paneDir), { AGENT_FARM_TELEMETRY: 'on' }).env.AGENT_FARM_TELEMETRY).toBe('on');
  });
});

describe('installBundledAgentFarm with the pinned package', () => {
  it('recovers from an install that was killed mid-way, and keeps telemetry in Pane\'s folder', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    // What a killed `plugin install` leaves: its lock, and part of greenfield's files.
    mkdirSync(path.join(configRoot, '.plugins', 'install.lock'), { recursive: true });
    mkdirSync(path.join(configRoot, 'plugins', 'greenfield'), { recursive: true });
    writeFileSync(path.join(configRoot, 'plugins', 'greenfield', 'plugin.yaml'), 'name: gre');
    const status = await installBundledAgentFarm({ paneDir, log: () => undefined });
    expect(status.error).toBeUndefined();
    expect(status.state).toBe('ready');
    expect(Object.keys(status.plugins)).toEqual([...BUNDLED_AGENT_FARM_PLUGINS]);
    expect(JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8'))).toEqual({ telemetry: { enabled: false, directory: path.join(configRoot, 'telemetry') } });
  }, 120_000);

  it('keeps a bundled plugin you edited when a Pane update brings a new bundle, and updates the others', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const first = await installBundledAgentFarm({ paneDir, log: () => undefined });
    expect(first).toMatchObject({ state: 'ready', edited: [] });
    const readme = path.join(configRoot, 'plugins', 'greenfield', 'agents', 'mine.md');
    writeFileSync(readme, '# my own subagent\n');
    const bundle = bundledAgentFarm();
    if (!bundle) throw new Error('Expected the pinned package');
    const logs: string[] = [];
    // A Pane release: same package files, a new version, so the manifest hash changes.
    const status = await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '9.9.9' }, log: (line) => logs.push(line) });
    expect(status.error).toBeUndefined();
    expect(status).toMatchObject({ state: 'ready', edited: ['greenfield'] });
    expect(status.plugins.greenfield).toBe(first.plugins.greenfield);
    expect(readFileSync(readme, 'utf8')).toBe('# my own subagent\n');
    expect(logs.join('\n')).toContain('kept greenfield because it was changed here');
    // The next start with the same bundle still reports it.
    const again = await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '9.9.9' }, log: () => undefined });
    expect(again.edited).toEqual(['greenfield']);
  }, 180_000);

  it('treats a changed installed file as an edit too', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    await installBundledAgentFarm({ paneDir, log: () => undefined });
    const bundle = bundledAgentFarm()!;
    writeFileSync(path.join(configRoot, 'plugins', 'dcouple', 'agents', 'astra-audits.md'), '---\nname: astra-audits\n---\nMine now.\n', { flag: 'a' });
    const status = await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '9.9.8' }, log: () => undefined });
    expect(status.error).toBeUndefined();
    expect(status).toMatchObject({ state: 'ready', edited: ['dcouple'] });
  }, 180_000);
});

describe('writeAgentFarmTelemetry', () => {
  it('turns telemetry off by default at install, and on only when asked, keeping other settings', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ provider: 'x', telemetry: { capture_content: false } }));
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner([]), log: () => undefined });
    const settings = () => JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8'));
    expect(settings()).toEqual({ provider: 'x', telemetry: { capture_content: false, enabled: false, directory: path.join(configRoot, 'telemetry') } });
    await writeAgentFarmTelemetry(paneDir, true);
    expect(settings().telemetry).toEqual({ capture_content: false, enabled: true, directory: path.join(configRoot, 'telemetry') });
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner([]), telemetry: true, log: () => undefined });
    expect(settings().telemetry.enabled).toBe(true);
    await writeAgentFarmTelemetry(paneDir, false);
    expect(settings().telemetry.enabled).toBe(false);
  });
});

describe('paneAgentFarmProcess', () => {
  it('is the bundled copy with Pane\'s config root, or undefined without a bundle', () => {
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { PATH: '/bin' }, bundle, '/Pane')).toEqual({ executable: '/Pane', args: ['/app/dist/cli.js', 'profiles', 'list', '--config-root', path.join('/pane', 'agent-farm')], env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', AGENT_FARM_TELEMETRY: 'off' } });
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], {}, null)).toBeUndefined();
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
