import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_AGENT_FARM_PLUGINS,
  RETIRED_AGENT_FARM_PLUGINS,
  agentFarmConfigRoot,
  bundledAgentFarm,
  agentFarmTelemetrySync,
  bundledAgentFarmProcess,
  installBundledAgentFarm,
  paneAgentFarmHarness,
  listPaneAgentFarmProfiles,
  paneAgentFarmProcess,
  reinstallBundledPlugin,
  writeAgentFarmTelemetry,
  type AgentFarmProcess,
  type BundledAgentFarm,
} from './bundledAgentFarm';
import { parseProfileListJson, profileListEntries } from './agentFarmProfiles';
import { writeProfileSync } from './profileSyncFile';
import { pendingRecoveries } from './agentFarmRecovery';
import { configuredAgent } from '../../../../shared/agents';

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
    if (process.args[2] === 'validate') return '{}\n';
    if (fail) throw Object.assign(new Error('Command failed'), { stderr: `warning\n${fail}\n` });
    // No name installs greenfield; a path installs the plugin in that folder (Pane's own).
    const name = process.args[3] === '--config-root' ? 'greenfield' : path.basename(process.args[3]);
    mkdirSync(path.join(root, 'plugins', name), { recursive: true });
    // A plugin from a folder is copied, as Agent Farm does.
    if (process.args[3] !== '--config-root' && path.isAbsolute(process.args[3])) cpSync(process.args[3], path.join(root, 'plugins', name), { recursive: true });
    return `note: installed\n{\n  "name": "${name}",\n  "version": "1.2.3",\n  "changed": 4\n}\n`;
  };
}

/** Where an older packaged Pane installed its bundled plugins from (a real receipt's `source.path`). */
const OLD_BUNDLE = '/Applications/Pane.app/Contents/Resources/app.asar/node_modules/@greenfieldco/agent-farm/plugins';

/**
 * A retired plugin's files and Agent Farm's receipt for them. By default what an older Pane left:
 * installed from its bundled package's plugins folder.
 */
function installRetired(paneDir: string, name: string, source: Record<string, string> = { path: `${OLD_BUNDLE}/${name}` }): void {
  const configRoot = agentFarmConfigRoot(paneDir);
  mkdirSync(path.join(configRoot, 'plugins', name), { recursive: true });
  mkdirSync(path.join(configRoot, '.plugins'), { recursive: true });
  writeFileSync(path.join(configRoot, '.plugins', `${name}.json`), JSON.stringify({ layout: 2, source }));
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
    expect(Object.keys(status.plugins)).toEqual([...BUNDLED_AGENT_FARM_PLUGINS, 'pane']);
    expect(calls.map((call) => call.args.slice(1))).toEqual([
      ['plugin', 'install', '--config-root', path.join(paneDir, 'agent-farm')],
      ['plugin', 'install', path.join(paneDir, 'agent-farm', 'pane-plugin', 'pane'), '--config-root', path.join(paneDir, 'agent-farm')],
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
    expect(Object.keys(status.plugins)).toEqual(['greenfield', 'pane']);
    expect(Object.keys(JSON.parse(readFileSync(manifestPath, 'utf8')).plugins)).toEqual(['greenfield', 'pane']);
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
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({ ...manifest, plugins: { greenfield: '1.2.3', pane: '1.2.3' } });
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
    // greenfield, then Pane's own plugin.
    expect(calls.map((call) => call.args.slice(1, 3))).toEqual([['plugin', 'install'], ['plugin', 'install']]);
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
    expect(calls.map((call) => call.args.slice(1, 3))).toEqual([['plugin', 'uninstall'], ['plugin', 'install'], ['plugin', 'install']]);
    expect(logs).toContainEqual(expect.stringContaining("Pane couldn't uninstall the retired Agent Farm plugin dcouple"));
    expect(logs).toContainEqual(expect.stringContaining('error: permission denied'));
  });

  it('uninstalls a retired plugin an older Pane installed from its pack, whose plugin.yaml names the stock repository', async () => {
    const paneDir = tempDir();
    installRetired(paneDir, 'dcouple', { repository: 'https://github.com/greenfield-inc/skills.git' });
    installRetired(paneDir, 'bigbrain', { repository: 'https://github.com/greenfield-inc/agent-farm' });
    const calls: AgentFarmProcess[] = [];
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls), log: () => undefined });
    expect(calls.filter((call) => call.args[2] === 'uninstall').map((call) => call.args[3])).toEqual(['dcouple', 'bigbrain']);
  });

  // Review F-1: Pane no longer ships dcouple, so the Profiles editor accepts the name, and a save can arrive by sync.
  it('keeps a plugin with a retired name that was made or synced here, with its files and receipt', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    // Made in the Profiles editor: installed from its staging folder.
    installRetired(paneDir, 'dcouple', { path: path.join(configRoot, 'drafts', '.new-dcouple-1a2b3c4d', 'dcouple') });
    writeFileSync(path.join(configRoot, 'plugins', 'dcouple', 'plugin.yaml'), 'name: dcouple\n');
    // An edited stock copy that arrived from another computer: its receipt names the stock repository.
    installRetired(paneDir, 'bigbrain', { repository: 'https://github.com/greenfield-inc/agent-farm' });
    await writeProfileSync(configRoot, { version: 1, plugins: { bigbrain: { state: 'saved', hash: 'abc', savedAt: 1, machine: 'other' } }, computers: {} });
    const calls: AgentFarmProcess[] = [];
    const logs: string[] = [];
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls), log: (line) => logs.push(line) });
    expect(calls.filter((call) => call.args[2] === 'uninstall')).toEqual([]);
    expect(readFileSync(path.join(configRoot, 'plugins', 'dcouple', 'plugin.yaml'), 'utf8')).toBe('name: dcouple\n');
    expect(existsSync(path.join(configRoot, '.plugins', 'dcouple.json'))).toBe(true);
    expect(existsSync(path.join(configRoot, '.plugins', 'bigbrain.json'))).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining('Kept the Agent Farm plugin dcouple'));
    expect(logs).toContainEqual(expect.stringContaining('Kept the Agent Farm plugin bigbrain'));
  });

  it('keeps a retired name whose receipt names no source or another repository, since Pane can\'t tell it is the stock copy', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    installRetired(paneDir, 'dcouple', {});
    installRetired(paneDir, 'bigbrain', { repository: 'https://github.com/someone/bigbrain.git' });
    const calls: AgentFarmProcess[] = [];
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner(calls), log: () => undefined });
    expect(calls.filter((call) => call.args[2] === 'uninstall')).toEqual([]);
    expect(existsSync(path.join(configRoot, '.plugins', 'dcouple.json'))).toBe(true);
    expect(existsSync(path.join(configRoot, '.plugins', 'bigbrain.json'))).toBe(true);
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
    expect(calls).toHaveLength(BUNDLED_AGENT_FARM_PLUGINS.length + 1);
    const again: AgentFarmProcess[] = [];
    await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '0.2.35' }, run: recordingRunner(again), log: () => undefined });
    expect(again).toHaveLength(BUNDLED_AGENT_FARM_PLUGINS.length + 1);
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

  // T-83 P3: through the shim's launcher, Agent Farm prints the shim in child launches.
  it('runs the agent-farm shim\'s launcher in place of the entry when given one', () => {
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.3.0' };
    const process = bundledAgentFarmProcess(bundle, ['run', 'greenfield/planner'], '/pane/agent-farm', { PATH: '/bin', AGENT_FARM_TELEMETRY: 'off' }, '/Pane.exe', true, '/pane/bin/agent-farm.cjs');
    expect(process.args).toEqual(['/pane/bin/agent-farm.cjs', 'run', 'greenfield/planner', '--config-root', '/pane/agent-farm']);
  });

  // A repository's .agent-farm/workspace.yaml outranks settings.json; only AGENT_FARM_TELEMETRY outranks it.
  it('turns telemetry off for the launch while Profiles is on, unless Pane\'s switch is on, keeping a value already set', async () => {
    const paneDir = tempDir();
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    const env = () => bundledAgentFarmProcess(bundle, ['run', 'p'], agentFarmConfigRoot(paneDir), { PATH: '/bin' }).env.AGENT_FARM_TELEMETRY;
    const saveConfig = (config: { agentFarmTelemetry?: boolean }) => writeFileSync(path.join(paneDir, 'config.json'), JSON.stringify({ sessionProfilesEnabled: true, ...config }));
    saveConfig({});
    expect(env()).toBe('off');
    await writeAgentFarmTelemetry(paneDir, false);
    expect(env()).toBe('off');
    saveConfig({ agentFarmTelemetry: true });
    await writeAgentFarmTelemetry(paneDir, true);
    expect(env()).toBeUndefined();
    // Review F-2: Pane's saved switch is off but settings.json still says on (its write failed).
    saveConfig({ agentFarmTelemetry: false });
    expect(env()).toBe('off');
    saveConfig({ agentFarmTelemetry: true });
    await writeAgentFarmTelemetry(paneDir, false);
    expect(bundledAgentFarmProcess(bundle, ['run', 'p'], agentFarmConfigRoot(paneDir), { AGENT_FARM_TELEMETRY: 'on' }).env.AGENT_FARM_TELEMETRY).toBe('on');
  });
});

describe('bundledAgentFarmProcess with Profiles off', () => {
  // As main launches it: Agent Farm's own default decides, whatever Pane's telemetry switch says.
  it('leaves telemetry to Agent Farm, for a missing or switched-off config, or when the caller says Profiles is off', () => {
    const paneDir = tempDir();
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    const env = (profiles?: boolean) => bundledAgentFarmProcess(bundle, ['run', 'p'], agentFarmConfigRoot(paneDir), { PATH: '/bin' }, undefined, profiles).env;
    expect(env()).toEqual({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
    writeFileSync(path.join(paneDir, 'config.json'), '{ not json');
    expect(env(false).AGENT_FARM_TELEMETRY).toBeUndefined();
    writeFileSync(path.join(paneDir, 'config.json'), JSON.stringify({ agentFarmTelemetry: false, sessionProfilesEnabled: false }));
    expect(env().AGENT_FARM_TELEMETRY).toBeUndefined();
    // The removed Profiles engine's key turns nothing on.
    writeFileSync(path.join(paneDir, 'config.json'), JSON.stringify({ profilesEnabled: true }));
    expect(env().AGENT_FARM_TELEMETRY).toBeUndefined();
  });
});

// Review F-7: Pane still has Profiles on (its last good config) while config.json on disk is broken.
describe('bundledAgentFarmProcess with an unreadable config.json', () => {
  it('holds telemetry off when the caller says Profiles is on, and when nobody says', () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: { enabled: true } }));
    writeFileSync(path.join(paneDir, 'config.json'), '{ not json');
    const env = (profiles?: boolean) => bundledAgentFarmProcess(bundle, ['run', 'p'], configRoot, { PATH: '/bin' }, undefined, profiles).env.AGENT_FARM_TELEMETRY;
    expect(env(true)).toBe('off');
    expect(env()).toBe('off');
    // Readable again, with the switch on, the caller's Profiles state still decides.
    writeFileSync(path.join(paneDir, 'config.json'), JSON.stringify({ agentFarmTelemetry: true }));
    expect(env(true)).toBeUndefined();
    expect(env(false)).toBeUndefined();
  });
});

describe('reinstallBundledPlugin (Restore, review F-1)', () => {
  it('puts your edited plugin and its receipt back when the install fails part-way', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    mkdirSync(path.join(configRoot, '.plugins'), { recursive: true });
    writeFileSync(path.join(configRoot, '.plugins', 'greenfield.json'), '{"version":"1.2.3","checksums":{}}\n');
    writeFileSync(path.join(configRoot, 'plugins', 'greenfield', 'mine.md'), '# mine\n');
    // A timeout after Agent Farm copied part of the plugin.
    const partial = async (agentFarm: AgentFarmProcess) => {
      mkdirSync(path.join(configRoot, 'plugins', 'greenfield'), { recursive: true });
      writeFileSync(path.join(configRoot, 'plugins', 'greenfield', 'plugin.yaml'), 'name: gre');
      throw Object.assign(new Error('Command failed'), { stderr: `error: timed out ${agentFarm.args.length}\n` });
    };
    await expect(reinstallBundledPlugin(paneDir, 'greenfield', bundle, partial)).rejects.toThrow('Command failed');
    expect(readFileSync(path.join(configRoot, 'plugins', 'greenfield', 'mine.md'), 'utf8')).toBe('# mine\n');
    expect(existsSync(path.join(configRoot, 'plugins', 'greenfield', 'plugin.yaml'))).toBe(false);
    expect(readFileSync(path.join(configRoot, '.plugins', 'greenfield.json'), 'utf8')).toContain('1.2.3');
    expect(existsSync(path.join(configRoot, 'pane-installing.json'))).toBe(false);
    expect(existsSync(path.join(configRoot, 'pane-restore', 'greenfield'))).toBe(false);
  });

  it('replaces the edited copy and clears what it set aside when the install succeeds', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    writeFileSync(path.join(configRoot, 'plugins', 'greenfield', 'mine.md'), '# mine\n');
    await reinstallBundledPlugin(paneDir, 'greenfield', bundle, recordingRunner([]));
    expect(existsSync(path.join(configRoot, 'plugins', 'greenfield', 'mine.md'))).toBe(false);
    expect(existsSync(path.join(configRoot, 'plugins', 'greenfield'))).toBe(true);
    expect(existsSync(path.join(configRoot, 'pane-restore', 'greenfield'))).toBe(false);
  });

  it('makes the next start reinstall a plugin whose install never finished, even when its folder exists and the bundle is unchanged', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const bundle = fakeBundle();
    await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner([]), log: () => undefined });
    // What a crash mid-Restore leaves: the marker, and the folder a partial install recreated.
    writeFileSync(path.join(configRoot, 'pane-installing.json'), '["greenfield"]\n');
    const calls: AgentFarmProcess[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle, run: recordingRunner(calls), log: () => undefined });
    expect(status.state).toBe('ready');
    expect(calls[0]?.args.slice(1, 3)).toEqual(['plugin', 'install']);
    expect(existsSync(path.join(configRoot, 'pane-installing.json'))).toBe(false);
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
    const status = await installBundledAgentFarm({ paneDir, telemetry: false, log: () => undefined });
    expect(status.error).toBeUndefined();
    expect(status.state).toBe('ready');
    expect(Object.keys(status.plugins)).toEqual([...BUNDLED_AGENT_FARM_PLUGINS, 'pane']);
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

  // Review F-10: an unreadable receipt can't prove the folder is Pane's own copy, so it stays.
  for (const [label, breakReceipt] of [
    ['invalid JSON', (file: string) => writeFileSync(file, '{"version":')],
    ['no checksums', (file: string) => writeFileSync(file, '{"version":"1.0.0"}')],
    ['unreadable', (file: string) => { rmSync(file); mkdirSync(file); }],
  ] as const) {
    it(`keeps an edited plugin whose receipt is ${label} when a Pane update brings a new bundle, and says why`, async () => {
      const paneDir = tempDir();
      const configRoot = agentFarmConfigRoot(paneDir);
      await installBundledAgentFarm({ paneDir, log: () => undefined });
      const mine = path.join(configRoot, 'plugins', 'greenfield', 'agents', 'mine.md');
      writeFileSync(mine, '# my own subagent\n');
      breakReceipt(path.join(configRoot, '.plugins', 'greenfield.json'));
      const logs: string[] = [];
      const status = await installBundledAgentFarm({ paneDir, bundle: { ...bundledAgentFarm()!, version: '9.9.7' }, log: (line) => logs.push(line) });
      expect(readFileSync(mine, 'utf8')).toBe('# my own subagent\n');
      expect(status).toMatchObject({ state: 'failed', edited: ['greenfield'] });
      expect(status.error).toContain(path.join(configRoot, '.plugins', 'greenfield.json'));
      expect(logs.join('\n')).toContain('updated none');
      // The next start checks and says so again, still keeping the folder.
      const again = await installBundledAgentFarm({ paneDir, bundle: { ...bundledAgentFarm()!, version: '9.9.7' }, log: () => undefined });
      expect(again).toMatchObject({ state: 'failed', edited: ['greenfield'] });
      expect(readFileSync(mine, 'utf8')).toBe('# my own subagent\n');
    }, 180_000);
  }

  it('treats a changed installed file as an edit too', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    await installBundledAgentFarm({ paneDir, log: () => undefined });
    const bundle = bundledAgentFarm()!;
    writeFileSync(path.join(configRoot, 'plugins', 'greenfield', 'agents', 'advisor.md'), '\nMine now.\n', { flag: 'a' });
    const status = await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '9.9.8' }, log: () => undefined });
    expect(status.error).toBeUndefined();
    expect(status).toMatchObject({ state: 'ready', edited: ['greenfield'] });
  }, 180_000);

  // Review F-3: an edited greenfield from Agent Farm 0.2 can name a variant 0.3 refuses (opus), and
  // then `profiles list` fails for every plugin, so New Session shows no named profiles.
  it('saves an edited greenfield this Agent Farm rejects, unchanged, and installs the shipped one so profiles still list', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    await installBundledAgentFarm({ paneDir, log: () => undefined });
    const bundle = bundledAgentFarm()!;
    const seo = path.join(configRoot, 'plugins', 'greenfield', 'profiles', 'seo.yaml');
    const stock = readFileSync(seo, 'utf8');
    const legacy = stock.replace('default: claude', '  opus:\n    agent: seo\ndefault: claude');
    writeFileSync(seo, legacy);
    const receipt = readFileSync(path.join(configRoot, '.plugins', 'greenfield.json'), 'utf8');
    const logs: string[] = [];
    const status = await installBundledAgentFarm({ paneDir, bundle: { ...bundle, version: '9.9.7' }, log: (line) => logs.push(line) });
    expect(status.error).toBeUndefined();
    expect(status).toMatchObject({ state: 'ready', edited: [] });
    expect(status.recovered).toHaveLength(1);
    const { folder, reason } = status.recovered![0];
    expect(reason).toContain('opus');
    // The recovery copy is the edited plugin and its receipt, byte for byte, with a note.
    expect(readFileSync(path.join(folder, 'plugin', 'profiles', 'seo.yaml'), 'utf8')).toBe(legacy);
    expect(readFileSync(path.join(folder, 'receipt.json'), 'utf8')).toBe(receipt);
    expect(readFileSync(path.join(folder, 'README.txt'), 'utf8')).toContain('rejects it');
    expect(path.dirname(folder)).toBe(path.join(configRoot, 'recovered'));
    expect(readFileSync(seo, 'utf8')).toBe(stock);
    expect(existsSync(path.join(configRoot, 'drafts'))).toBe(false);
    expect(logs.join('\n')).toContain(`Pane saved it unchanged in ${folder}`);
    // The Profiles tab tells you once (agentFarmRecovery.ts).
    expect(await pendingRecoveries(configRoot)).toEqual([{ id: path.basename(folder), plugin: 'greenfield', folder }]);
    const listed = await listPaneAgentFarmProfiles(paneDir);
    expect(listed.error).toBeUndefined();
    expect(listed.profiles.map((entry) => entry.ref)).toEqual(expect.arrayContaining(['greenfield/seo', 'greenfield/business', 'greenfield/orchestrator']));
  }, 180_000);
});

describe('installBundledAgentFarm after a partial install (review F-1)', () => {
  /** Runs Agent Farm for real, but fails a matching command as a timeout or crash would. */
  const failing = (arg?: string) => async (agentFarm: AgentFarmProcess) => {
    if (arg && agentFarm.args.includes(arg)) throw Object.assign(new Error('Command failed'), { stderr: 'error: timed out\n' });
    return (await promisify(execFile)(agentFarm.executable, agentFarm.args, { env: agentFarm.env })).stdout;
  };

  it('keeps an edit to a plugin that finished installing when a later plugin failed, and installs the failed one on retry', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    // Pane's own plugin installs after greenfield, so it is the later plugin that fails.
    const failed = await installBundledAgentFarm({ paneDir, run: failing(path.join(configRoot, 'pane-plugin', 'pane')), log: () => undefined });
    expect(failed.state).toBe('failed');
    const advisor = path.join(configRoot, 'plugins', 'greenfield', 'agents', 'advisor.md');
    writeFileSync(advisor, '\nMine.\n', { flag: 'a' });
    const retried = await installBundledAgentFarm({ paneDir, run: failing(), log: () => undefined });
    expect(retried.error).toBeUndefined();
    expect(retried).toMatchObject({ state: 'ready', edited: ['greenfield'] });
    expect(readFileSync(advisor, 'utf8')).toContain('Mine.');
    expect(readFileSync(path.join(configRoot, '.plugins', 'pane.json'), 'utf8')).toContain('"name": "pane"');
  }, 180_000);
});

describe('Pane\'s own plugin with the pinned package', () => {
  it('installs pane/claude and pane/codex with only a harness and the contract\'s model, and replaces an edit', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const first = await installBundledAgentFarm({ paneDir, log: () => undefined });
    expect(first.error).toBeUndefined();
    const bundle = bundledAgentFarm()!;
    const list = (): string => {
      const process = bundledAgentFarmProcess(bundle, ['profiles', 'list', '--json'], configRoot);
      return execFileSync(process.executable, process.args, { env: process.env, encoding: 'utf8' });
    };
    const plain = profileListEntries(parseProfileListJson(list())).filter((entry) => entry.plugin === 'pane');
    expect(plain.map(({ ref, harness, model, hidden }) => ({ ref, harness, model, hidden }))).toEqual([
      { ref: 'pane/claude', harness: 'claude', model: configuredAgent('claude').chat?.profileModel, hidden: true },
      { ref: 'pane/codex', harness: 'codex', model: configuredAgent('codex').chat?.profileModel, hidden: true },
    ]);
    // Only harness, model and description: no identity text, skills or subagents.
    expect(readFileSync(path.join(configRoot, 'plugins', 'pane', 'agents', 'claude.md'), 'utf8').split('---')[2].trim()).toBe('');
    writeFileSync(path.join(configRoot, 'plugins', 'pane', 'agents', 'claude.md'), '---\nharness: claude\nmodel:\n  name: claude-sonnet-5-5\n---\nMine.\n');
    // The same bundle at the next start: the edit is still replaced (QA F4).
    const status = await installBundledAgentFarm({ paneDir, log: () => undefined });
    expect(status).toMatchObject({ state: 'ready', edited: [] });
    expect(readFileSync(path.join(configRoot, 'plugins', 'pane', 'agents', 'claude.md'), 'utf8')).not.toContain('Mine.');
  }, 180_000);
});

describe('writeAgentFarmTelemetry', () => {
  it('turns telemetry off by default at install while Profiles is on, and on only when asked, keeping other settings', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ provider: 'x', telemetry: { capture_content: false } }));
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner([]), telemetry: false, log: () => undefined });
    const settings = () => JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8'));
    expect(settings()).toEqual({ provider: 'x', telemetry: { capture_content: false, enabled: false, directory: path.join(configRoot, 'telemetry') } });
    await writeAgentFarmTelemetry(paneDir, true);
    expect(settings().telemetry).toEqual({ capture_content: false, enabled: true, directory: path.join(configRoot, 'telemetry') });
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner([]), telemetry: true, log: () => undefined });
    expect(settings().telemetry.enabled).toBe(true);
    await writeAgentFarmTelemetry(paneDir, false);
    expect(settings().telemetry.enabled).toBe(false);
  });

  it('with Profiles off, only points telemetry at Pane\'s folder, as main does, and takes back the on or off Pane wrote', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const settings = () => JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8'));
    const directory = path.join(configRoot, 'telemetry');
    await installBundledAgentFarm({ paneDir, bundle: fakeBundle(), run: recordingRunner([]), log: () => undefined });
    expect(settings()).toEqual({ telemetry: { directory } });
    // On, then off again: Pane's own `enabled: false` goes, so Agent Farm's default is back.
    await writeAgentFarmTelemetry(paneDir, false);
    expect(settings().telemetry).toEqual({ enabled: false, directory });
    await writeAgentFarmTelemetry(paneDir, undefined);
    expect(settings()).toEqual({ telemetry: { directory } });
    expect(existsSync(path.join(configRoot, 'pane-telemetry.json'))).toBe(false);
    // A value someone wrote by hand stays.
    writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: { enabled: false, directory } }));
    await writeAgentFarmTelemetry(paneDir, undefined);
    expect(settings().telemetry).toEqual({ enabled: false, directory });
    // And one changed by hand after Pane wrote it.
    await writeAgentFarmTelemetry(paneDir, true);
    writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: { enabled: false, directory } }));
    await writeAgentFarmTelemetry(paneDir, undefined);
    expect(settings().telemetry).toEqual({ enabled: false, directory });
  });
});

// Review F-5: an opt-out (or opt-in) set before Profiles came on is what Profiles off gives back.
describe('writeAgentFarmTelemetry keeps what was there before Profiles', () => {
  for (const before of [false, true, undefined]) {
    it(`restores enabled: ${before} after Profiles goes on and off, through on and off of the switch`, async () => {
      const paneDir = tempDir();
      const configRoot = agentFarmConfigRoot(paneDir);
      const directory = path.join(configRoot, 'telemetry');
      mkdirSync(configRoot, { recursive: true });
      writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: before === undefined ? { directory } : { enabled: before, directory } }));
      const settings = () => JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8')).telemetry;
      await writeAgentFarmTelemetry(paneDir, false);
      expect(settings().enabled).toBe(false);
      await writeAgentFarmTelemetry(paneDir, true);
      await writeAgentFarmTelemetry(paneDir, false);
      await writeAgentFarmTelemetry(paneDir, undefined);
      expect(settings()).toEqual(before === undefined ? { directory } : { enabled: before, directory });
      expect(existsSync(path.join(configRoot, 'pane-telemetry.json'))).toBe(false);
    });
  }
});

// Review F-6: Profiles on then off while the first write is still pending; the last toggle wins.
describe('agentFarmTelemetrySync', () => {
  it('writes one at a time and ends on the latest wanted value', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    let wanted: boolean | undefined = false;
    const order: Array<boolean | undefined> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started: () => void = () => undefined;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    let active = 0;
    const sync = agentFarmTelemetrySync(paneDir, () => wanted, {
      write: async (dir, value) => {
        active += 1;
        expect(active).toBe(1);
        order.push(value);
        if (order.length === 1) { started(); await gate; }
        await writeAgentFarmTelemetry(dir, value);
        active -= 1;
      },
      onError: error => { throw error; },
    });
    const first = sync.sync();
    await firstStarted;
    // Profiles turned off while the first write is still pending.
    wanted = undefined;
    const second = sync.sync();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([false, undefined]);
    expect(JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8')).telemetry).toEqual({ directory: path.join(configRoot, 'telemetry') });
    // Nothing more to do when nothing changed.
    await sync.sync();
    expect(order).toHaveLength(2);
  });

  it('reports a failed write and tries again at the next sync', async () => {
    const paneDir = tempDir();
    const errors: unknown[] = [];
    let fail = true;
    const writes: Array<boolean | undefined> = [];
    const sync = agentFarmTelemetrySync(paneDir, () => true, {
      write: async (_dir, value) => { writes.push(value); if (fail) throw new Error('read-only'); },
      onError: error => errors.push(error),
    });
    await sync.sync();
    expect(errors).toHaveLength(1);
    fail = false;
    await sync.sync();
    expect(writes).toEqual([true, true]);
    expect(errors).toHaveLength(1);
  });
});

// Review F-6: a settings.json write that fails after Pane's record changed must not lose the opt-out.
describe('writeAgentFarmTelemetry when a settings.json write fails', () => {
  /** Makes settings.json read-only for one write, as a full disk or a locked file would refuse it. */
  async function refused(paneDir: string, enabled: boolean | undefined): Promise<void> {
    const file = path.join(agentFarmConfigRoot(paneDir), 'settings.json');
    chmodSync(file, 0o444);
    try { await expect(writeAgentFarmTelemetry(paneDir, enabled)).rejects.toThrow(); }
    finally { chmodSync(file, 0o644); }
  }

  function setUp() {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const directory = path.join(configRoot, 'telemetry');
    mkdirSync(configRoot, { recursive: true });
    // The person's own opt-out, made before Profiles.
    writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: { enabled: false, directory } }));
    return { paneDir, directory, settings: () => JSON.parse(readFileSync(path.join(configRoot, 'settings.json'), 'utf8')).telemetry };
  }

  it('gives back the opt-out at Profiles off when turning the switch off never reached settings.json', async () => {
    const { paneDir, settings, directory } = setUp();
    await writeAgentFarmTelemetry(paneDir, true);
    await refused(paneDir, false);
    expect(settings()).toEqual({ enabled: true, directory });
    await writeAgentFarmTelemetry(paneDir, undefined);
    expect(settings()).toEqual({ enabled: false, directory });
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'pane-telemetry.json'))).toBe(false);
  });

  it('finishes an interrupted restoration at the next write, and keeps the opt-out if Profiles comes back on', async () => {
    const { paneDir, settings, directory } = setUp();
    await writeAgentFarmTelemetry(paneDir, true);
    await refused(paneDir, false);
    await refused(paneDir, undefined);
    expect(settings()).toEqual({ enabled: true, directory });
    // Profiles back on, the switch on, then off for good.
    await writeAgentFarmTelemetry(paneDir, true);
    await writeAgentFarmTelemetry(paneDir, undefined);
    expect(settings()).toEqual({ enabled: false, directory });
  });
});

// Review F-4: a Session checks a non-default variant's agent with Agent Farm before it is saved.
describe('paneAgentFarmHarness with the pinned package', () => {
  it('reads the harness a variant really runs, and undefined for a profile Agent Farm lacks', async () => {
    const paneDir = tempDir();
    const status = await installBundledAgentFarm({ paneDir, telemetry: false, log: () => undefined });
    expect(status.state).toBe('ready');
    expect(await paneAgentFarmHarness(paneDir, 'greenfield/orchestrator:codex')).toBe('codex');
    expect(await paneAgentFarmHarness(paneDir, 'greenfield/orchestrator')).toBe('claude');
    expect(await paneAgentFarmHarness(paneDir, 'greenfield/no-such-profile')).toBeUndefined();
  }, 120_000);
});

describe('paneAgentFarmProcess', () => {
  it('is the bundled copy with Pane\'s config root, or undefined without a bundle', () => {
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { env: { PATH: '/bin' }, bundle, runtime: '/Pane', profiles: false })).toEqual({ executable: '/Pane', args: ['/app/dist/cli.js', 'profiles', 'list', '--config-root', path.join('/pane', 'agent-farm')], env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' } });
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { env: { PATH: '/bin' }, bundle, runtime: '/Pane', profiles: true })?.env.AGENT_FARM_TELEMETRY).toBe('off');
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { env: {}, bundle: null })).toBeUndefined();
  });
});

describe('the pinned package', () => {
  // T-83 P1: Agent Farm 0.3.0 carries greenfield 0.1.0 (three profiles; every helper is a linked agent).
  it('is 0.3.0 in both package.json files, and resolves and answers --version with this Node', () => {
    const pin = (file: string) => JSON.parse(readFileSync(path.join(__dirname, file), 'utf8')).dependencies['@greenfieldco/agent-farm'];
    expect([pin('../../../../package.json'), pin('../../../package.json')]).toEqual(['0.3.0', '0.3.0']);
    const bundle = bundledAgentFarm();
    expect(bundle?.version).toBe('0.3.0');
    if (!bundle) return;
    const process = bundledAgentFarmProcess(bundle, ['--version'], tempDir());
    // --version takes no config root; run the entry alone.
    expect(execFileSync(process.executable, [bundle.entry, '--version'], { env: process.env, encoding: 'utf8' }).trim()).toBe('0.3.0');
  });

  // electron-builder strips `scripts` from every package.json it packs, which changes a bundled
  // plugin's checksummed files, and Agent Farm >= 0.2.44 then refuses to install it (T-63 PR 8 notes).
  it('keeps package.json scripts when packaging, so bundled plugins match their checksums', () => {
    const build = JSON.parse(readFileSync(path.join(__dirname, '../../../../package.json'), 'utf8')).build;
    expect(build.removePackageScripts).toBe(false);
  });

  it('ships greenfield\'s three profiles and no dcouple', () => {
    const bundle = bundledAgentFarm();
    if (!bundle) throw new Error('the pinned Agent Farm package is missing');
    expect(readdirSync(path.join(bundle.root, 'plugins'))).not.toContain('dcouple');
    expect(readdirSync(path.join(bundle.root, 'plugins', 'greenfield', 'profiles')).filter((file) => file.endsWith('.yaml')).sort()).toEqual(['business.yaml', 'orchestrator.yaml', 'seo.yaml']);
  });
});
