import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentFarmConfigRoot, bundledAgentFarm, bundledAgentFarmProcess, installBundledAgentFarm, listPaneAgentFarmProfiles, runAgentFarm, type AgentFarmRunner } from './bundledAgentFarm';
import { ProfileEditor, agentFarmReason, parseYaml } from './profileEditor';
import type { ProfileSubagentNode, ProfileTreeNode } from '../../../../shared/types/profileEditor';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-'));
  temporary.push(dir);
  return dir;
}

const bundle = bundledAgentFarm();
if (!bundle) throw new Error('Expected the pinned @greenfieldco/agent-farm package');

/** A small plugin, as someone would write one, installed into the Pane's Agent Farm with the real CLI. */
async function installFixture(paneDir: string, name = 'labtest', extra: Record<string, string> = {}): Promise<void> {
  const source = path.join(tempDir(), name);
  const files = {
    'plugin.yaml': `name: ${name}\nversion: 0.1.0\ncli_major: 0\n`,
    'profiles/writer.yaml': 'agent: writer\n',
    'agents/writer.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Drafts blog posts\ninstructions_files:\n  - ../instructions/tone.md\nskills:\n  - outline\n---\n\n# Writer\n',
    'agents/editor.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Edits\n---\n\n# Editor\n',
    'instructions/tone.md': '# Tone\n',
    'skills/outline/SKILL.md': '---\nname: outline\ndescription: Outline a post\n---\n\nOutline first.\n',
    ...extra,
  };
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    writeFileSync(path.join(source, relative), content);
  }
  const run = bundledAgentFarmProcess(bundle!, ['plugin', 'install', source], agentFarmConfigRoot(paneDir));
  await execFileAsync(run.executable, run.args, { env: run.env });
}

function editor(paneDir: string): ProfileEditor {
  return new ProfileEditor({ paneDir, machine: () => 'studio-mac', bundle });
}

describe('ProfileEditor: list and read', () => {
  it('lists each installed plugin with its profiles, identity, harness and Agent Farm\'s description', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const overview = await editor(paneDir).list();
    expect(overview.machine).toBe('studio-mac');
    expect(overview.error).toBeUndefined();
    const plugin = overview.plugins.find(entry => entry.name === 'labtest');
    expect(plugin).toMatchObject({ version: '0.1.0', bundled: false, edited: false });
    expect(plugin?.files).toEqual(['agents/editor.md', 'agents/writer.md', 'instructions/tone.md', 'plugin.yaml', 'profiles/writer.yaml', 'skills/outline/SKILL.md']);
    expect(plugin?.profiles).toEqual([expect.objectContaining({
      name: 'writer', ref: 'labtest/writer', entry: 'agents/writer.md', harness: 'claude', model: 'claude-opus-5-5', description: 'Drafts blog posts',
    })]);
    expect(plugin?.profiles[0]).not.toHaveProperty('variants');
  }, 60_000);

  it('reads a file, and refuses a path outside the plugin or through a link', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    expect(await profiles.read('labtest', 'agents/writer.md')).toContain('# Writer');
    await expect(profiles.read('labtest', '../.plugins/labtest.json')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    await expect(profiles.read('labtest', '/etc/hosts')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    await expect(profiles.read('../labtest', 'plugin.yaml')).rejects.toMatchObject({ code: 'PROFILE_NAME_INVALID' });
    await expect(profiles.read('pane', 'plugin.yaml')).rejects.toMatchObject({ code: 'PROFILE_NAME_INVALID' });
    const outside = path.join(tempDir(), 'secret.md');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest', 'references-link.md'));
    await expect(profiles.read('labtest', 'references-link.md')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
  }, 60_000);

  it.skipIf(process.platform === 'win32')('leaves a linked section folder and a linked identity out of the list, as a read refuses them (review F-7)', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const root = path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest');
    const outside = tempDir();
    writeFileSync(path.join(outside, 'secret.md'), 'secret');
    writeFileSync(path.join(outside, 'writer.md'), '---\nharness: claude\ndescription: From outside the plugin\n---\n');
    symlinkSync(outside, path.join(root, 'references'));
    rmSync(path.join(root, 'agents', 'writer.md'));
    symlinkSync(path.join(outside, 'writer.md'), path.join(root, 'agents', 'writer.md'));
    const plugin = (await editor(paneDir).list()).plugins.find(entry => entry.name === 'labtest');
    expect(plugin?.files.some(file => file.startsWith('references/'))).toBe(false);
    expect(plugin?.profiles[0]?.description).not.toBe('From outside the plugin');
  }, 60_000);
});

describe('ProfileEditor: save', () => {
  it('saves a valid change in place', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const result = await editor(paneDir).save('labtest', [{ path: 'agents/writer.md', content: '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Drafts blog posts\nskills:\n  - outline\n---\n\n# Writer\n\nMarker: KUMQUAT\n' }]);
    expect(result.path).toBe('agents/writer.md');
    expect(readFileSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest', 'agents', 'writer.md'), 'utf8')).toContain('Marker: KUMQUAT');
    expect(JSON.stringify(result.plugin.profiles[0].tree)).not.toContain('instructions/tone.md');
  }, 60_000);

  it('refuses a change Agent Farm rejects, naming the reason, and changes nothing', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const file = path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest', 'agents', 'writer.md');
    const before = readFileSync(file, 'utf8');
    await expect(editor(paneDir).save('labtest', [{ path: 'agents/writer.md', content: '---\nharness: claude\nmodel: claude-opus-5-5\nskills:\n  - missing-skill\n---\n' }]))
      .rejects.toMatchObject({ code: 'PROFILE_INVALID', message: expect.stringContaining('missing-skill') });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'drafts', 'labtest'))).toBe(false);
  }, 60_000);

  it('names the YAML error, not the snippet under it, when a file doesn\'t parse', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const error = await editor(paneDir).save('labtest', [{ path: 'agents/writer.md', content: '---\nharness: claude\nmodel: claude-opus-5-5\nbad: [x\n---\n' }]).catch(cause => cause);
    expect(error).toMatchObject({ code: 'PROFILE_INVALID' });
    expect(error.message).toContain('Agent Farm says labtest/agents/writer.md: Flow sequence');
    expect(error.message).toMatch(/line \d+/);
    expect(error.message).not.toMatch(/says \^/);
  }, 60_000);

    it('refuses to write outside the plugin sections', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    await expect(editor(paneDir).save('labtest', [{ path: 'agents/../../escape.md', content: 'x' }])).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    await expect(editor(paneDir).save('labtest', [{ path: 'notes.txt', content: 'x' }])).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'escape.md'))).toBe(false);
  }, 60_000);
});

describe('ProfileEditor: new profile, subagent, skill and reference', () => {
  it('creates a profile as an installed plugin with its identity file', async () => {
    const paneDir = tempDir();
    const result = await editor(paneDir).newProfile('researcher', 'claude');
    expect(result.path).toBe('agents/researcher.md');
    expect(result.plugin.profiles).toEqual([expect.objectContaining({ ref: 'researcher/researcher', harness: 'claude', entry: 'agents/researcher.md' })]);
    const overview = await editor(paneDir).list();
    expect(overview.plugins.map(plugin => plugin.name)).toContain('researcher');
    await expect(editor(paneDir).newProfile('researcher', 'claude')).rejects.toMatchObject({ code: 'PROFILE_EXISTS' });
    await expect(editor(paneDir).newProfile('Bad Name', 'claude')).rejects.toMatchObject({ code: 'PROFILE_NAME_INVALID' });
  }, 60_000);

  // Review F-1: Pane no longer ships dcouple, so the name is free here, and a restart must not retire the new profile.
  it('keeps a profile created under a retired plugin name across a restart', async () => {
    const paneDir = tempDir();
    await editor(paneDir).newProfile('dcouple', 'claude');
    const configRoot = agentFarmConfigRoot(paneDir);
    const identity = readFileSync(path.join(configRoot, 'plugins', 'dcouple', 'agents', 'dcouple.md'), 'utf8');
    const status = await installBundledAgentFarm({ paneDir, bundle, log: () => undefined });
    expect(status.state).toBe('ready');
    expect(readFileSync(path.join(configRoot, 'plugins', 'dcouple', 'agents', 'dcouple.md'), 'utf8')).toBe(identity);
    expect(existsSync(path.join(configRoot, '.plugins', 'dcouple.json'))).toBe(true);
    const listed = await listPaneAgentFarmProfiles(paneDir);
    expect(listed.profiles.map(entry => entry.ref)).toContain('dcouple/dcouple');
  }, 180_000);

  it('adds a subagent, a skill and a reference to a profile, and shows them in its tree', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    expect((await profiles.newFile('labtest', 'writer', 'subagent', 'researcher')).path).toBe('agents/researcher.md');
    expect((await profiles.newFile('labtest', 'writer', 'skill', 'weekly-recap')).path).toBe('skills/weekly-recap/SKILL.md');
    const last = await profiles.newFile('labtest', 'writer', 'reference', 'style-guide');
    expect(last.path).toBe('references/writer/style-guide.md');
    const shown = JSON.stringify(last.plugin.profiles[0].tree);
    for (const file of ['agents/researcher.md', 'skills/weekly-recap/SKILL.md', 'references/writer/style-guide.md', 'skills/outline/SKILL.md']) expect(shown).toContain(file);
    const identity = await profiles.read('labtest', 'agents/writer.md');
    expect(identity).toContain('weekly-recap');
    expect(identity).toContain('researcher');
    expect(identity).toContain('references: writer');
    // A second reference goes into the same folder.
    expect((await profiles.newFile('labtest', 'writer', 'reference', 'glossary')).path).toBe('references/writer/glossary.md');
    await expect(profiles.newFile('labtest', 'writer', 'skill', 'weekly-recap')).rejects.toMatchObject({ code: 'PROFILE_EXISTS' });
    // Agent Farm still accepts the plugin.
    const run = bundledAgentFarmProcess(bundle!, ['plugin', 'validate', path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest')], agentFarmConfigRoot(paneDir));
    await execFileAsync(run.executable, run.args, { env: run.env });
  }, 60_000);
});

describe('ProfileEditor: a save that fails part-way (review F-6)', () => {
  it.skipIf(process.platform === 'win32')('takes back a new skill when its identity can\'t be written, so trying again works', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    const root = path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest');
    const identity = readFileSync(path.join(root, 'agents', 'writer.md'), 'utf8');
    // agents/ refuses writes, so the skill is written and then its identity fails.
    chmodSync(path.join(root, 'agents'), 0o555);
    try {
      await expect(profiles.newFile('labtest', 'writer', 'skill', 'weekly-recap')).rejects.toThrow();
    } finally {
      chmodSync(path.join(root, 'agents'), 0o755);
    }
    expect(existsSync(path.join(root, 'skills', 'weekly-recap'))).toBe(false);
    expect(readFileSync(path.join(root, 'agents', 'writer.md'), 'utf8')).toBe(identity);
    expect((await profiles.newFile('labtest', 'writer', 'skill', 'weekly-recap')).path).toBe('skills/weekly-recap/SKILL.md');
  }, 60_000);
});

describe('ProfileEditor: photos (SVG only, through Agent Farm, T-83)', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#e3735e"/></svg>';

  it('keeps your SVG as Agent Farm\'s display override, outside the plugin, and removes it', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    await profiles.setPhoto('labtest/writer', SVG);
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'profile-overrides', 'labtest', 'writer.svg'))).toBe(true);
    const photos = await profiles.photos();
    expect(photos.profiles['labtest/writer']).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
    expect(photos.sources['labtest/writer']).toBe('yours');
    // Nothing of Pane's own is written, and the plugin is untouched.
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'avatars'))).toBe(false);
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'drafts'))).toBe(false);
    await profiles.removePhoto('labtest/writer');
    expect((await profiles.photos()).profiles['labtest/writer']).toBeUndefined();
  }, 60_000);

  it('reads a photo file again only once it changed, since the tab asks every few seconds (review F-6)', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    await profiles.setPhoto('labtest/writer', SVG);
    const file = path.join(agentFarmConfigRoot(paneDir), 'profile-overrides', 'labtest', 'writer.svg');
    const asSaved = `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`;
    // A whole-second time, so it can be set back exactly.
    const mtime = new Date(Math.floor(statSync(file).mtimeMs / 1000) * 1000);
    utimesSync(file, mtime, mtime);
    expect((await profiles.photos()).profiles['labtest/writer']).toBe(asSaved);
    // The same size and time, other bytes: the photo read before is reused.
    const recolored = SVG.replace('#e3735e', '#4b7bd8');
    writeFileSync(file, recolored);
    utimesSync(file, mtime, mtime);
    expect((await profiles.photos()).profiles['labtest/writer']).toBe(asSaved);
    // A newer file is read again.
    utimesSync(file, new Date(mtime.getTime() + 5_000), new Date(mtime.getTime() + 5_000));
    expect((await profiles.photos()).profiles['labtest/writer']).toBe(`data:image/svg+xml;base64,${Buffer.from(recolored).toString('base64')}`);
  }, 60_000);

  it('refuses a PNG, an SVG Agent Farm\'s check refuses, one over 64 KB, and a bad ref, naming the reason', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    await expect(profiles.setPhoto('labtest/writer', '\u0089PNG\r\n')).rejects.toMatchObject({ code: 'PROFILE_PHOTO_INVALID', message: expect.stringContaining('SVG only') });
    await expect(profiles.setPhoto('labtest/writer', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>'))
      .rejects.toMatchObject({ code: 'PROFILE_DETAILS_REFUSED', message: expect.stringContaining('<script>') });
    await expect(profiles.setPhoto('labtest/writer', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>${'x'.repeat(65 * 1024)}</title></svg>`))
      .rejects.toMatchObject({ code: 'PROFILE_PHOTO_INVALID', message: expect.stringContaining('64 KB') });
    await expect(profiles.setPhoto('../x/writer', SVG)).rejects.toMatchObject({ code: 'PROFILE_NAME_INVALID' });
    expect((await profiles.photos()).profiles['labtest/writer']).toBeUndefined();
  }, 60_000);

  it('shows the plugin\'s own SVG photo, and yours over it until you remove yours', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir, 'labtest', { 'profiles/writer.yaml': 'agent: writer\ntitle: Writer\nphoto: writer.svg\n', 'profiles/writer.svg': SVG.replace('#e3735e', '#4b7bd8') });
    const profiles = editor(paneDir);
    expect((await profiles.photos()).sources['labtest/writer']).toBe('plugin');
    await profiles.setPhoto('labtest/writer', SVG);
    expect((await profiles.photos()).sources['labtest/writer']).toBe('yours');
    await profiles.removePhoto('labtest/writer');
    const after = await profiles.photos();
    expect(after.sources['labtest/writer']).toBe('plugin');
    expect(Buffer.from(after.profiles['labtest/writer'].split(',')[1], 'base64').toString()).toContain('#4b7bd8');
  }, 60_000);
});

describe('ProfileEditor: Pane\'s own plugins (A-3)', () => {
  it('marks an edited bundled plugin Edited, keeps it a photo away from Edited, and restores Pane\'s version', async () => {
    const paneDir = tempDir();
    const status = await installBundledAgentFarm({ paneDir, bundle, log: () => undefined });
    expect(status.state).toBe('ready');
    const profiles = editor(paneDir);
    const before = (await profiles.list()).plugins.find(plugin => plugin.name === 'greenfield');
    expect(before).toMatchObject({ bundled: true, edited: false });
    expect((await profiles.list()).plugins.map(plugin => plugin.name)).not.toContain('pane');
    const ref = before!.profiles[0].ref;
    await profiles.setPhoto(ref, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#40916c"/></svg>');
    expect((await profiles.list()).plugins.find(plugin => plugin.name === 'greenfield')?.edited).toBe(false);
    const entry = before!.profiles[0].entry;
    const original = await profiles.read('greenfield', entry);
    await profiles.save('greenfield', [{ path: entry, content: `${original}\nMarker: LYCHEE\n` }]);
    expect((await profiles.list()).plugins.find(plugin => plugin.name === 'greenfield')?.edited).toBe(true);
    // Launches still find it: Agent Farm lists it with its pack checksums now stale.
    const listed = await listPaneAgentFarmProfiles(paneDir);
    expect(listed.error).toBeUndefined();
    expect(listed.profiles.map(profile => profile.ref)).toContain(ref);
    const restored = await profiles.restore('greenfield');
    expect(restored.plugin.edited).toBe(false);
    expect(await profiles.read('greenfield', entry)).toBe(original);
    // Your photo stays through the restore.
    expect((await profiles.photos()).sources[ref]).toBe('yours');
    const manifest = JSON.parse(readFileSync(path.join(agentFarmConfigRoot(paneDir), 'pane-manifest.json'), 'utf8'));
    expect(manifest.edited ?? []).not.toContain('greenfield');
    await expect(profiles.restore('labtest')).rejects.toMatchObject({ code: 'PROFILE_NOT_BUNDLED' });
  }, 240_000);

  it('lists greenfield\'s three profiles with Agent Farm\'s titles and their trees (T-83)', async () => {
    const paneDir = tempDir();
    await installBundledAgentFarm({ paneDir, bundle, log: () => undefined });
    const greenfield = (await editor(paneDir).list()).plugins.find(plugin => plugin.name === 'greenfield');
    expect(greenfield?.profiles.map(profile => [profile.ref, profile.title, profile.variants])).toEqual([
      ['greenfield/business', 'Business', ['claude', 'codex']],
      ['greenfield/orchestrator', 'Orchestrator', ['claude', 'codex']],
      ['greenfield/seo', 'SEO', expect.anything()],
    ]);
    const orchestrator = greenfield!.profiles.find(profile => profile.name === 'orchestrator')!;
    const subagents = orchestrator.tree.find(node => node.kind === 'folder' && node.label === 'Subagents');
    const links = subagents?.kind === 'folder' ? subagents.children.flatMap(node => (node.kind === 'subagent' ? [node] : [])) : [];
    // J3: 13 launch links plus advisor, and no process-cleanup.
    expect(links.filter(link => link.mode === 'launch')).toHaveLength(13);
    expect(links.map(link => link.alias)).toContain('advisor');
    expect(links.map(link => link.alias)).not.toContain('process-cleanup');
    // Reviewer links implementer, whose own reviewer link is the cycle back.
    const reviewer = links.find(link => link.alias === 'reviewer')!;
    const implementer = findSubagent(reviewer.children, 'implementer');
    expect(implementer).toMatchObject({ mode: 'launch', variants: ['claude', 'codex'] });
    expect(findSubagent(implementer!.children, 'reviewer')).toMatchObject({ cycle: true, children: [] });
    expect(reviewer.command).toBe('agent-farm run greenfield/reviewer --agent-only');
  }, 240_000);
});

/** A subagent node by alias among `nodes`' Subagents folder. */
function findSubagent(nodes: ProfileTreeNode[], alias: string): ProfileSubagentNode | undefined {
  const folder = nodes.find(node => node.kind === 'folder' && node.label === 'Subagents');
  return folder?.kind === 'folder' ? folder.children.find((node): node is ProfileSubagentNode => node.kind === 'subagent' && node.alias === alias) : undefined;
}

describe('agentFarmReason', () => {
  it('takes the error line over a YAML snippet, and shows the staged folder as the plugin with / on Windows too', () => {
    const stderr = 'error: C:\\Pane\\agent-farm\\drafts\\.staging-labtest-1\\agents\\writer.md: Flow sequence at line 3, column 8:\n\n  bad: [x\n  ^\n';
    expect(agentFarmReason({ stderr, fallback: 'failed' }, ['C:\\Pane\\agent-farm\\drafts\\.staging-labtest-1'], 'labtest'))
      .toBe('labtest/agents/writer.md: Flow sequence at line 3, column 8');
    expect(agentFarmReason({ stderr: '', fallback: 'spawn failed' })).toBe('spawn failed');
  });
});

/**
 * A team plugin: a lead that starts a planner (also a profile) as a launch link and runs a designer
 * inside itself; the planner may start the lead again, a cycle only launch links allow.
 */
async function installTeam(paneDir: string): Promise<void> {
  const source = path.join(tempDir(), 'team');
  const files = {
    'plugin.yaml': 'name: team\nversion: 0.1.0\ncli_major: 0\n',
    'profiles/lead.yaml': 'agent: lead\ntitle: Lead\n',
    'profiles/planner.yaml': 'agent: planner\n',
    'agents/lead.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Runs the work\ninstructions_files:\n  - ../instructions/rules.md\nskills:\n  - plan\nreferences: lead\nsubagents:\n  planner:\n    agent: planner\n    mode: launch\n    description: Writes the plan\n  designer:\n    agent: designer\n    mode: native\n---\n\n# Lead\n\nRun one workstream.\n',
    'agents/planner.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Plans\nskills:\n  - plan\nsubagents:\n  lead:\n    agent: lead\n    mode: launch\n---\n\n# Planner\n',
    'agents/designer.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Draws options\nskills:\n  - mockup\n---\n\n# Designer\n',
    'instructions/rules.md': '# Rules\n',
    'skills/plan/SKILL.md': '---\nname: plan\ndescription: Plan\n---\n\nPlan.\n',
    'skills/plan/references/template.md': '# Template\n',
    'skills/mockup/SKILL.md': '---\nname: mockup\ndescription: Mock up\n---\n\nDraw.\n',
    'references/lead/style.md': '# Style\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    writeFileSync(path.join(source, relative), content);
  }
  const run = bundledAgentFarmProcess(bundle!, ['plugin', 'install', source], agentFarmConfigRoot(paneDir));
  await execFileAsync(run.executable, run.args, { env: run.env });
}

/** A tree as indented labels, for comparing its shape. */
function outline(nodes: ProfileTreeNode[], depth = 0): string[] {
  const label = (node: ProfileTreeNode) => {
    if (node.kind === 'file') return node.label + (node.note ? ` (${node.note})` : '');
    if (node.kind === 'folder') return `${node.label}/`;
    return `@${node.label} <${node.mode}>${node.profile ? ` [${node.profile}]` : ''}${node.cycle ? ' (cycle)' : ''}`;
  };
  return nodes.flatMap(node => [`${'  '.repeat(depth)}${label(node)}`, ...(node.kind === 'file' ? [] : outline(node.children, depth + 1))]);
}

describe('ProfileEditor: the profile page', () => {
  it('builds each profile\'s own tree: identity, instructions, skills, references, its links from Agent Farm nested, settings', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const lead = (await editor(paneDir).list()).plugins.find(plugin => plugin.name === 'team')?.profiles.find(profile => profile.name === 'lead');
    expect(lead).toMatchObject({ title: 'Lead', description: 'Runs the work', entry: 'agents/lead.md', harness: 'claude' });
    expect(outline(lead!.tree)).toEqual([
      'lead.md (identity)',
      'Instructions/',
      '  rules.md',
      'Skills/',
      '  plan/',
      '    references/',
      '      template.md',
      '    SKILL.md',
      'References/',
      '  style.md',
      // In Agent Farm's order: native links, then launch links.
      'Subagents/',
      '  @Designer <native>',
      '    designer.md (identity)',
      '    Skills/',
      '      mockup/',
      '        SKILL.md',
      '  @Planner <launch> [team/planner]',
      '    planner.md (identity)',
      '    Skills/',
      '      plan/',
      '        references/',
      '          template.md',
      '        SKILL.md',
      '    Subagents/',
      '      @Lead <launch> [team/lead] (cycle)',
      'Settings/',
      '  lead.yaml',
    ]);
    const planner = findSubagent(lead!.tree, 'planner');
    // The link's own description, and the command a person runs it with.
    expect(planner).toMatchObject({ description: 'Writes the plan', command: 'agent-farm run team/planner --agent-only', harness: 'claude', model: 'claude-opus-5-5', identity: 'agents/planner.md' });
    // Every id is unique, so folders open and close on their own.
    const ids: string[] = [];
    const walk = (nodes: ProfileTreeNode[]) => nodes.forEach(node => { ids.push(node.id); if (node.kind !== 'file') walk(node.children); });
    walk(lead!.tree);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it('saves the title and description through Agent Farm, leaving the plugin\'s files as they are', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const profiles = editor(paneDir);
    const identity = await profiles.read('team', 'agents/lead.md');
    const result = await profiles.setDetails('team', 'lead', { title: 'Team lead', description: 'Runs one workstream: "plan, build, review".' });
    expect(result.plugin.profiles.find(profile => profile.name === 'lead')).toMatchObject({ title: 'Team lead', description: 'Runs one workstream: "plan, build, review".' });
    expect(await profiles.read('team', 'agents/lead.md')).toBe(identity);
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'team', 'pane.yaml'))).toBe(false);
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'profile-overrides', 'team', 'lead.json'))).toBe(true);
    // The subagent row of a profile with a title shows that title.
    const planner = await profiles.setDetails('team', 'planner', { title: 'Plan writer', description: 'Plans' });
    expect(outline(planner.plugin.profiles.find(profile => profile.name === 'lead')!.tree)).toContain('  @Plan writer <launch> [team/planner]');
    // Clearing both goes back to the plugin's own.
    const cleared = await profiles.setDetails('team', 'lead', { title: '', description: '' });
    expect(cleared.plugin.profiles.find(profile => profile.name === 'lead')).toMatchObject({ title: 'Lead', description: 'Runs the work' });
    // A cover file is found, and can be read and saved like the profile's other files.
    const lead = cleared.plugin.profiles.find(profile => profile.name === 'lead');
    expect(lead!.cover).toBeUndefined();
    await profiles.save('team', [{ path: 'covers/lead.html', content: '<h1>Lead</h1>' }]);
    const after = (await profiles.list()).plugins.find(plugin => plugin.name === 'team');
    expect(after?.profiles.find(profile => profile.name === 'lead')?.cover).toBe('covers/lead.html');
    expect(await profiles.read('team', 'covers/lead.html')).toBe('<h1>Lead</h1>');
    await expect(profiles.read('team', 'covers/../agents/lead.md')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    await expect(profiles.read('team', 'pane.yaml')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    await expect(profiles.setDetails('team', 'nobody', { title: 'x', description: '' })).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  }, 60_000);

  it('shows a link pinned to a variant with that variant\'s identity and skills, an unpinned one with the default\'s (review F-5)', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir, 'pin', {
      'profiles/lead.yaml': 'agent: lead\n',
      'agents/lead.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Leads\nsubagents:\n  builder:\n    agent: builder\n    mode: launch\n    variant: codex\n  helper:\n    agent: builder\n    mode: launch\n---\n\n# Lead\n',
      'agents/builder.yaml': 'variants:\n  claude: { agent: builder-claude }\n  codex: { agent: builder-codex }\ndefault: claude\n',
      'agents/builder-claude.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Builds in Claude\nskills:\n  - claude-build\n---\n\n# Builder\n',
      'agents/builder-codex.md': '---\nharness: codex\nmodel: gpt-6.2-sol\ndescription: Builds in Codex\nskills:\n  - codex-build\n---\n\n# Builder\n',
      'skills/claude-build/SKILL.md': '---\nname: claude-build\ndescription: Build\n---\n\nBuild.\n',
      'skills/codex-build/SKILL.md': '---\nname: codex-build\ndescription: Build\n---\n\nBuild.\n',
    });
    const lead = (await editor(paneDir).list()).plugins.find(plugin => plugin.name === 'pin')?.profiles.find(profile => profile.name === 'lead');
    const pinned = findSubagent(lead!.tree, 'builder');
    expect(pinned).toMatchObject({ identity: 'agents/builder-codex.md', harness: 'codex', variants: ['codex'] });
    expect(outline(pinned!.children)).toContain('  codex-build/');
    expect(findSubagent(lead!.tree, 'helper')).toMatchObject({ identity: 'agents/builder-claude.md', harness: 'claude' });
  }, 60_000);

  it('saves a title and description that start with a dash, and clears them again (review F-7)', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const profiles = editor(paneDir);
    const result = await profiles.setDetails('team', 'lead', { title: '-Lead-', description: '- Review changes' });
    expect(result.plugin.profiles.find(profile => profile.name === 'lead')).toMatchObject({ title: '-Lead-', description: '- Review changes' });
    const cleared = await profiles.setDetails('team', 'lead', { title: '', description: '' });
    expect(cleared.plugin.profiles.find(profile => profile.name === 'lead')).toMatchObject({ title: 'Lead', description: 'Runs the work' });
  }, 60_000);

  it('keeps your title, description and photo of a bundled profile un-Edited and through Pane reinstalling it (J8)', async () => {
    const paneDir = tempDir();
    await installBundledAgentFarm({ paneDir, bundle, log: () => undefined });
    const profiles = editor(paneDir);
    const result = await profiles.setDetails('greenfield', 'orchestrator', { title: 'My orchestrator', description: 'Builds my features.' });
    await profiles.setPhoto('greenfield/orchestrator', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#7c3aed"/></svg>');
    expect(result.plugin.edited).toBe(false);
    // An update reinstalls greenfield (here, its restore); the edits are Agent Farm's override, which the install never sees.
    const restored = await profiles.restore('greenfield');
    expect(restored.plugin.profiles.find(profile => profile.name === 'orchestrator')).toMatchObject({ title: 'My orchestrator', description: 'Builds my features.' });
    expect((await profiles.photos()).sources['greenfield/orchestrator']).toBe('yours');
    // New Session's list shows the same title.
    expect((await listPaneAgentFarmProfiles(paneDir)).profiles.find(entry => entry.ref === 'greenfield/orchestrator')?.title).toBe('My orchestrator');
  }, 240_000);

  it('asks Agent Farm for the listing again only when a plugin file or an override changed', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const calls: string[][] = [];
    const run: AgentFarmRunner = async (process) => {
      calls.push(process.args);
      return runAgentFarm(process);
    };
    const counted = new ProfileEditor({ paneDir, machine: () => 'studio-mac', bundle, run });
    const lists = () => calls.filter(args => args.includes('list') && args.includes('--json')).length;
    await counted.list();
    await counted.list();
    expect(lists()).toBe(1);
    writeFileSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'team', 'profiles', 'extra.yaml'), 'agent: lead\n');
    expect((await counted.list()).plugins.find(plugin => plugin.name === 'team')?.profiles.map(profile => profile.name)).toContain('extra');
    expect(lists()).toBe(2);
    await counted.setDetails('team', 'lead', { title: 'Renamed', description: 'Runs the work' });
    expect(lists()).toBe(3);
  }, 60_000);
});

describe('parseYaml', () => {
  it('turns YAML into data, and says why it can\'t', () => {
    expect(parseYaml('variants:\n  claude: { agent: lead }\ndefault: claude\n')).toEqual({ data: { variants: { claude: { agent: 'lead' } }, default: 'claude' } });
    expect(parseYaml('bad: [x').error).toMatch(/line \d+/);
  });
});
