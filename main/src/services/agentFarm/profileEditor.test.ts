import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentFarmConfigRoot, bundledAgentFarm, bundledAgentFarmProcess, installBundledAgentFarm, listPaneAgentFarmProfiles, runAgentFarm, type AgentFarmRunner } from './bundledAgentFarm';
import { ProfileEditor, agentFarmReason, parseYaml } from './profileEditor';
import type { ProfileTreeNode } from '../../../../shared/types/profileEditor';
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
async function installFixture(paneDir: string, name = 'labtest'): Promise<void> {
  const source = path.join(tempDir(), name);
  const files = {
    'plugin.yaml': `name: ${name}\nversion: 0.1.0\ncli_major: 0\n`,
    'profiles/writer.yaml': 'agent: writer\n',
    'agents/writer.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Drafts blog posts\ninstructions_files:\n  - ../instructions/tone.md\nskills:\n  - outline\n---\n\n# Writer\n',
    'agents/editor.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Edits\n---\n\n# Editor\n',
    'instructions/tone.md': '# Tone\n',
    'skills/outline/SKILL.md': '---\nname: outline\ndescription: Outline a post\n---\n\nOutline first.\n',
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
  it('lists each installed plugin with its profiles, identity, harness and the files each profile uses', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const overview = await editor(paneDir).list();
    expect(overview.machine).toBe('studio-mac');
    expect(overview.error).toBeUndefined();
    const plugin = overview.plugins.find(entry => entry.name === 'labtest');
    expect(plugin).toMatchObject({ version: '0.1.0', bundled: false, edited: false });
    expect(plugin?.files).toEqual(['agents/editor.md', 'agents/writer.md', 'instructions/tone.md', 'plugin.yaml', 'profiles/writer.yaml', 'skills/outline/SKILL.md']);
    expect(plugin?.profiles).toEqual([expect.objectContaining({
      name: 'writer', ref: 'labtest/writer', entry: 'agents/writer.md', harness: 'claude', model: 'claude-opus-5-5', description: 'Drafts blog posts', listed: true,
      uses: ['agents/writer.md', 'instructions/tone.md', 'plugin.yaml', 'profiles/writer.yaml', 'skills/outline/SKILL.md'],
    })]);
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
});

describe('ProfileEditor: save', () => {
  it('saves a valid change in place', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const result = await editor(paneDir).save('labtest', [{ path: 'agents/writer.md', content: '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Drafts blog posts\nskills:\n  - outline\n---\n\n# Writer\n\nMarker: KUMQUAT\n' }]);
    expect(result.path).toBe('agents/writer.md');
    expect(readFileSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest', 'agents', 'writer.md'), 'utf8')).toContain('Marker: KUMQUAT');
    expect(result.plugin.profiles[0].uses).not.toContain('instructions/tone.md');
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

  it('adds a subagent, a skill and a reference to a profile, and lists them as used', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    expect((await profiles.newFile('labtest', 'writer', 'subagent', 'researcher')).path).toBe('agents/researcher.md');
    expect((await profiles.newFile('labtest', 'writer', 'skill', 'weekly-recap')).path).toBe('skills/weekly-recap/SKILL.md');
    const last = await profiles.newFile('labtest', 'writer', 'reference', 'style-guide');
    expect(last.path).toBe('references/writer/style-guide.md');
    expect(last.plugin.profiles[0].uses).toEqual(expect.arrayContaining(['agents/researcher.md', 'skills/weekly-recap/SKILL.md', 'references/writer/style-guide.md', 'skills/outline/SKILL.md']));
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

describe('ProfileEditor: photos', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6a3a50000000049454e44ae426082', 'hex');

  it('stores your photo per profile in avatars/, outside the plugin, and removes it', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    const profiles = editor(paneDir);
    await profiles.setPhoto('labtest/writer', PNG.toString('base64'));
    expect(existsSync(path.join(agentFarmConfigRoot(paneDir), 'avatars', 'labtest--writer.png'))).toBe(true);
    expect((await profiles.photos()).profiles['labtest/writer']).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    await profiles.removePhoto('labtest/writer');
    expect((await profiles.photos()).profiles['labtest/writer']).toBeUndefined();
    await expect(profiles.setPhoto('labtest/writer', Buffer.from('not an image').toString('base64'))).rejects.toMatchObject({ code: 'PROFILE_PHOTO_INVALID' });
    await expect(profiles.setPhoto('../x/writer', PNG.toString('base64'))).rejects.toMatchObject({ code: 'PROFILE_NAME_INVALID' });
  }, 60_000);

  it('reads a plugin\'s own picture from its avatar.png', async () => {
    const paneDir = tempDir();
    await installFixture(paneDir);
    writeFileSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'labtest', 'avatar.png'), PNG);
    expect((await editor(paneDir).photos()).plugins.labtest).toMatch(/^data:image\/png;base64,/);
  }, 60_000);
});

describe('ProfileEditor: Pane\'s own plugins (A-3)', () => {
  it('marks an edited bundled plugin Edited, keeps it a photo away from Edited, and restores Pane\'s version', async () => {
    const paneDir = tempDir();
    const status = await installBundledAgentFarm({ paneDir, bundle, log: () => undefined });
    expect(status.state).toBe('ready');
    const profiles = editor(paneDir);
    const before = (await profiles.list()).plugins.find(plugin => plugin.name === 'dcouple');
    expect(before).toMatchObject({ bundled: true, edited: false });
    expect((await profiles.list()).plugins.map(plugin => plugin.name)).not.toContain('pane');
    const ref = before!.profiles[0].ref;
    await profiles.setPhoto(ref, Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') + 'AAAA');
    expect((await profiles.list()).plugins.find(plugin => plugin.name === 'dcouple')?.edited).toBe(false);
    const entry = before!.profiles[0].entry;
    const original = await profiles.read('dcouple', entry);
    await profiles.save('dcouple', [{ path: entry, content: `${original}\nMarker: LYCHEE\n` }]);
    expect((await profiles.list()).plugins.find(plugin => plugin.name === 'dcouple')?.edited).toBe(true);
    // Launches still find it: Agent Farm lists it with its pack checksums now stale.
    const listed = await listPaneAgentFarmProfiles(paneDir);
    expect(listed.error).toBeUndefined();
    expect(listed.profiles.map(profile => profile.ref)).toContain(ref);
    const restored = await profiles.restore('dcouple');
    expect(restored.plugin.edited).toBe(false);
    expect(await profiles.read('dcouple', entry)).toBe(original);
    const manifest = JSON.parse(readFileSync(path.join(agentFarmConfigRoot(paneDir), 'pane-manifest.json'), 'utf8'));
    expect(manifest.edited ?? []).not.toContain('dcouple');
    await expect(profiles.restore('labtest')).rejects.toMatchObject({ code: 'PROFILE_NOT_BUNDLED' });
  }, 240_000);
});

describe('agentFarmReason', () => {
  it('takes the error line over a YAML snippet, and shows the staged folder as the plugin with / on Windows too', () => {
    const stderr = 'error: C:\\Pane\\agent-farm\\drafts\\.staging-labtest-1\\agents\\writer.md: Flow sequence at line 3, column 8:\n\n  bad: [x\n  ^\n';
    expect(agentFarmReason({ stderr, fallback: 'failed' }, ['C:\\Pane\\agent-farm\\drafts\\.staging-labtest-1'], 'labtest'))
      .toBe('labtest/agents/writer.md: Flow sequence at line 3, column 8');
    expect(agentFarmReason({ stderr: '', fallback: 'spawn failed' })).toBe('spawn failed');
  });
});

/** A team plugin: an orchestrator (lead) calling a planner that is also a profile, and a plain designer. */
async function installTeam(paneDir: string): Promise<void> {
  const source = path.join(tempDir(), 'team');
  const files = {
    'plugin.yaml': 'name: team\nversion: 0.1.0\ncli_major: 0\n',
    'profiles/lead.yaml': 'agent: lead\n',
    'profiles/planner.yaml': 'agent: planner\n',
    'agents/lead.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Runs the work\ninstructions_files:\n  - ../instructions/rules.md\nskills:\n  - plan\nreferences: lead\nsubagents:\n  planner:\n    agent: planner\n    mode: native\n  designer:\n    agent: designer\n    mode: native\n---\n\n# Lead\n\nRun one workstream.\n',
    'agents/planner.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Plans\nskills:\n  - plan\n---\n\n# Planner\n',
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
  return nodes.flatMap(node => [`${'  '.repeat(depth)}${node.kind === 'file' ? node.label + (node.note ? ` (${node.note})` : '') : node.kind === 'folder' ? `${node.label}/` : `@${node.label}${node.profile ? ` [${node.profile}]` : ''}`}`,
    ...(node.kind === 'file' ? [] : outline(node.children, depth + 1))]);
}

describe('ProfileEditor: the profile page', () => {
  it('builds each profile\'s own tree: identity, instructions, skills, references, subagents nested, settings', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const lead = (await editor(paneDir).list()).plugins.find(plugin => plugin.name === 'team')?.profiles.find(profile => profile.name === 'lead');
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
      'Subagents/',
      '  @Team planner [team/planner]',
      '    planner.md (identity)',
      '    Skills/',
      '      plan/',
      '        references/',
      '          template.md',
      '        SKILL.md',
      '  @Designer',
      '    designer.md (identity)',
      '    Skills/',
      '      mockup/',
      '        SKILL.md',
      'Settings/',
      '  lead.yaml',
    ]);
    // Every id is unique, so folders open and close on their own.
    const ids: string[] = [];
    const walk = (nodes: ProfileTreeNode[]) => nodes.forEach(node => { ids.push(node.id); if (node.kind !== 'file') walk(node.children); });
    walk(lead!.tree);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it('saves a title and description in pane.yaml, leaving the identity alone, and lists the plugin\'s cover page', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const profiles = editor(paneDir);
    const identity = await profiles.read('team', 'agents/lead.md');
    const result = await profiles.setDetails('team', 'lead', { title: 'Team lead', description: 'Runs one workstream end to end.' });
    expect(result.plugin.profiles.find(profile => profile.name === 'lead')).toMatchObject({ title: 'Team lead', description: 'Runs one workstream end to end.' });
    expect(await profiles.read('team', 'agents/lead.md')).toBe(identity);
    expect(await profiles.read('team', 'pane.yaml')).toContain('Team lead');
    // The subagent row of a profile with a title shows that title.
    const planner = await profiles.setDetails('team', 'planner', { title: 'Planner', description: '' });
    const lead = planner.plugin.profiles.find(profile => profile.name === 'lead');
    expect(outline(lead!.tree)).toContain('  @Planner [team/planner]');
    expect(planner.plugin.profiles.find(profile => profile.name === 'planner')?.description).toBe('Plans');
    // A cover file is found, and can be read and saved like the profile's other files.
    expect(lead!.cover).toBeUndefined();
    await profiles.save('team', [{ path: 'covers/lead.html', content: '<h1>Lead</h1>' }]);
    const after = (await profiles.list()).plugins.find(plugin => plugin.name === 'team');
    expect(after?.profiles.find(profile => profile.name === 'lead')?.cover).toBe('covers/lead.html');
    expect(await profiles.read('team', 'covers/lead.html')).toBe('<h1>Lead</h1>');
    await expect(profiles.read('team', 'covers/../agents/lead.md')).rejects.toMatchObject({ code: 'PROFILE_PATH_INVALID' });
    await expect(profiles.setDetails('team', 'nobody', { title: 'x', description: '' })).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  }, 60_000);

  it('keeps a bundled plugin un-Edited when only its details change', async () => {
    const paneDir = tempDir();
    await installBundledAgentFarm({ paneDir, bundle, log: () => undefined });
    const profiles = editor(paneDir);
    const first = (await profiles.list()).plugins.find(plugin => plugin.name === 'dcouple')!.profiles[0];
    const result = await profiles.setDetails('dcouple', first.name, { title: 'My business', description: '' });
    expect(result.plugin.edited).toBe(false);
  }, 240_000);

  it('hides a profile Agent Farm reports as not listed, and lists everything with an Agent Farm that has no --json', async () => {
    const paneDir = tempDir();
    await installTeam(paneDir);
    const calls: string[][] = [];
    const run: AgentFarmRunner = async (process) => {
      calls.push(process.args);
      if (process.args.includes('--json')) return JSON.stringify([{ qualified: 'team/lead', listed: true }, { qualified: 'team/planner', listed: false }]);
      return runAgentFarm(process);
    };
    const withListed = new ProfileEditor({ paneDir, machine: () => 'studio-mac', bundle, run });
    const team = (await withListed.list()).plugins.find(plugin => plugin.name === 'team');
    expect(team?.profiles.map(profile => [profile.name, profile.listed])).toEqual([['lead', true], ['planner', false]]);
    // Asked once; the next list reuses it until a profile file changes.
    await withListed.list();
    expect(calls.filter(args => args.includes('--json'))).toHaveLength(1);
    writeFileSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'team', 'profiles', 'extra.yaml'), 'agent: lead\n');
    await withListed.list();
    expect(calls.filter(args => args.includes('--json'))).toHaveLength(2);
    // Agent Farm 0.2.34 refuses --json: every profile is listed.
    const old = (await editor(paneDir).list()).plugins.find(plugin => plugin.name === 'team');
    expect(old?.profiles.every(profile => profile.listed)).toBe(true);
  }, 60_000);
});

describe('parseYaml', () => {
  it('turns YAML into data, and says why it can\'t', () => {
    expect(parseYaml('variants:\n  claude: { agent: lead }\ndefault: claude\n')).toEqual({ data: { variants: { claude: { agent: 'lead' } }, default: 'claude' } });
    expect(parseYaml('bad: [x').error).toMatch(/line \d+/);
  });
});
