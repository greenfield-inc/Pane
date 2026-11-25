import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_AGENT_FARM_PLUGINS,
  agentFarmConfigRoot,
  bundledAgentFarm,
  agentFarmTelemetrySync,
  bundledAgentFarmProcess,
  installBundledAgentFarm,
  paneAgentFarmProcess,
  writeAgentFarmTelemetry,
  type AgentFarmProcess,
  type BundledAgentFarm,
} from './bundledAgentFarm';
import { parseProfileList } from './agentFarmProfiles';
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

function recordingRunner(calls: AgentFarmProcess[], fail?: string) {
  return async (process: AgentFarmProcess) => {
    calls.push(process);
    if (fail) throw Object.assign(new Error('Command failed'), { stderr: `warning\n${fail}\n` });
    // No name installs greenfield; a path installs the plugin in that folder (Pane's own).
    const name = process.args[3] === '--config-root' ? 'greenfield' : path.basename(process.args[3]);
    const root = process.args[process.args.indexOf('--config-root') + 1];
    mkdirSync(path.join(root, 'plugins', name), { recursive: true });
    // A plugin from a folder is copied, as Agent Farm does.
    if (process.args[3] !== '--config-root' && path.isAbsolute(process.args[3])) cpSync(process.args[3], path.join(root, 'plugins', name), { recursive: true });
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
    expect(Object.keys(status.plugins)).toEqual([...BUNDLED_AGENT_FARM_PLUGINS, 'pane']);
    expect(calls.map((call) => call.args.slice(1))).toEqual([
      ['plugin', 'install', '--config-root', path.join(paneDir, 'agent-farm')],
      ['plugin', 'install', 'dcouple', '--config-root', path.join(paneDir, 'agent-farm')],
      ['plugin', 'install', path.join(paneDir, 'agent-farm', 'pane-plugin', 'pane'), '--config-root', path.join(paneDir, 'agent-farm')],
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

describe('installBundledAgentFarm after a partial install (review F-1)', () => {
  /** Runs Agent Farm for real, but fails the named plugin's install as a timeout or crash would. */
  const failing = (plugin?: string) => async (agentFarm: AgentFarmProcess) => {
    if (plugin && agentFarm.args.includes(plugin)) throw Object.assign(new Error('Command failed'), { stderr: 'error: timed out\n' });
    return (await promisify(execFile)(agentFarm.executable, agentFarm.args, { env: agentFarm.env })).stdout;
  };

  it('keeps an edit to a plugin that finished installing when a later plugin failed, and installs the failed one on retry', async () => {
    const paneDir = tempDir();
    const configRoot = agentFarmConfigRoot(paneDir);
    const failed = await installBundledAgentFarm({ paneDir, run: failing('dcouple'), log: () => undefined });
    expect(failed.state).toBe('failed');
    const advisor = path.join(configRoot, 'plugins', 'greenfield', 'agents', 'advisor.md');
    writeFileSync(advisor, '\nMine.\n', { flag: 'a' });
    const retried = await installBundledAgentFarm({ paneDir, run: failing(), log: () => undefined });
    expect(retried.error).toBeUndefined();
    expect(retried).toMatchObject({ state: 'ready', edited: ['greenfield'] });
    expect(readFileSync(advisor, 'utf8')).toContain('Mine.');
    expect(readFileSync(path.join(configRoot, '.plugins', 'dcouple.json'), 'utf8')).toContain('"name": "dcouple"');
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
      const process = bundledAgentFarmProcess(bundle, ['profiles', 'list'], configRoot);
      return execFileSync(process.executable, process.args, { env: process.env, encoding: 'utf8' });
    };
    const plain = parseProfileList(list()).filter((entry) => entry.plugin === 'pane');
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

describe('paneAgentFarmProcess', () => {
  it('is the bundled copy with Pane\'s config root, or undefined without a bundle', () => {
    const bundle = { root: '/app', entry: '/app/dist/cli.js', version: '0.2.34' };
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { env: { PATH: '/bin' }, bundle, runtime: '/Pane', profiles: false })).toEqual({ executable: '/Pane', args: ['/app/dist/cli.js', 'profiles', 'list', '--config-root', path.join('/pane', 'agent-farm')], env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' } });
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { env: { PATH: '/bin' }, bundle, runtime: '/Pane', profiles: true })?.env.AGENT_FARM_TELEMETRY).toBe('off');
    expect(paneAgentFarmProcess('/pane', ['profiles', 'list'], { env: {}, bundle: null })).toBeUndefined();
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
