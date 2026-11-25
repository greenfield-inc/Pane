import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentFarmConfigRoot, bundledAgentFarm, bundledAgentFarmProcess, installBundledAgentFarm, listPaneAgentFarmProfiles } from './bundledAgentFarm';
import { ProfileEditor } from './profileEditor';
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
    expect(plugin?.profiles).toEqual([{
      name: 'writer', ref: 'labtest/writer', entry: 'agents/writer.md', harness: 'claude', model: 'claude-opus-5-5', description: 'Drafts blog posts',
      uses: ['agents/writer.md', 'instructions/tone.md', 'plugin.yaml', 'profiles/writer.yaml', 'skills/outline/SKILL.md'],
    }]);
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
