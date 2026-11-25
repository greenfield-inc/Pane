import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { DEFAULT_AGENT_ID, configuredAgent } from '../../../../shared/agents';
import { PANE_PROFILE_PLUGIN, plainProfileAgents } from '../../../../shared/agentProfiles';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import {
  PROFILE_NAME_PATTERN,
  type ProfileFileChange,
  type ProfileNewFileKind,
  type ProfilePhotos,
  type ProfilePlugin,
  type ProfileSaveResult,
  type ProfileSummary,
  type ProfilesOverview,
} from '../../../../shared/types/profileEditor';
import {
  BUNDLED_AGENT_FARM_PLUGINS,
  agentFarmConfigRoot,
  bundledAgentFarm,
  bundledAgentFarmProcess,
  installedState,
  reinstallBundledPlugin,
  runAgentFarm,
  type AgentFarmRunner,
  type BundledAgentFarm,
} from './bundledAgentFarm';

/** The folders of a plugin Agent Farm reads, besides plugin.yaml (Agent Farm's plugins.js). */
const SECTIONS = ['profiles', 'agents', 'skills', 'instructions', 'references'];
/** Largest photo Pane keeps; the tab scales a chosen picture down to well under this. */
const MAX_PHOTO_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const BUNDLED: readonly string[] = BUNDLED_AGENT_FARM_PLUGINS;

export interface ProfileEditorOptions {
  paneDir: string;
  /** This computer's name, which the tab shows. */
  machine?: () => string;
  /** The bundled Agent Farm; undefined finds it, null means this build has none. */
  bundle?: BundledAgentFarm | null;
  run?: AgentFarmRunner;
  /** Called after a plugin's files changed (save, new file, restore), so Sessions using it can show the changed dot. */
  onChanged?: (plugin: string) => void;
}

const receiptSchema = boundary.object({ name: boundary.string, layout: boundary.optional(boundary.number) });
const stringList = boundary.array(boundary.string);

/** Frontmatter of an agent file: the YAML between the leading `---` lines, and where it ends. */
interface Frontmatter {
  data: JsonObject;
  /** The frontmatter's own lines, without the `---` fences. */
  lines: string[];
  /** Everything after the closing fence. */
  body: string;
}

function parseFrontmatter(text: string): Frontmatter | undefined {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return undefined;
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return undefined;
  const inner = normalized.slice(4, end);
  const afterFence = normalized.indexOf('\n', end + 4);
  const body = afterFence < 0 ? '' : normalized.slice(afterFence + 1);
  try {
    const loaded = yaml.load(inner);
    const data = decodeOptionalBoundary(loaded, boundary.jsonObject) ?? {};
    return { data, lines: inner.split('\n'), body };
  } catch {
    return undefined;
  }
}

function renderFrontmatter(lines: string[], body: string): string {
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function text(value: JsonValue | undefined): string | undefined {
  return decodeOptionalBoundary(value, boundary.string)?.trim() || undefined;
}

/** An agent's model: a name, or a mapping with one (`model: { name, reasoning }`). */
function modelName(value: JsonValue | undefined): string | undefined {
  return text(value) ?? text(decodeOptionalBoundary(value, boundary.jsonObject)?.name);
}

function titleCase(name: string): string {
  return name.split(/[-_]/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function nameError(name: string, what: string): PaneError {
  return new PaneError('PROFILE_NAME_INVALID', `"${name}" isn't a ${what} name Pane can use.`, 'Use lowercase letters, digits, - and _, starting with a letter.');
}

function checkName(name: string, what = 'plugin'): void {
  if (!PROFILE_NAME_PATTERN.test(name) || (what === 'plugin' && name === PANE_PROFILE_PLUGIN)) throw nameError(name, what);
}

/** A plugin-relative path with `/`, checked to stay inside plugin.yaml and the plugin's sections. */
function checkRelative(relative: string): string[] {
  const parts = relative.split('/');
  const inside = relative === 'plugin.yaml' || (SECTIONS.includes(parts[0]) && parts.length > 1);
  if (!inside || path.isAbsolute(relative) || relative.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new PaneError('PROFILE_PATH_INVALID', `"${relative}" isn't a file inside the plugin.`, 'Use a path inside its profiles, agents, skills, instructions or references folder, or plugin.yaml.');
  }
  return parts;
}

/** Refuses a path whose folders or file are links, so nothing is read or written outside the plugin. */
async function checkNoLinks(root: string, parts: string[]): Promise<void> {
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new PaneError('PROFILE_PATH_INVALID', `${parts.join('/')} is a link, which Pane doesn't follow in a profile.`, 'Replace the link with the file itself.');
    if (!stat) return;
  }
}

async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, file);
}

/** Every file of a plugin Agent Farm reads, relative with `/`, sorted; links are left out. */
async function pluginFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    const children = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const full = path.join(folder, child.name);
      if (child.isDirectory()) await visit(full);
      else if (child.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  for (const section of SECTIONS) await visit(path.join(root, section));
  if ((await fs.lstat(path.join(root, 'plugin.yaml')).catch(() => undefined))?.isFile()) files.push('plugin.yaml');
  return files.sort();
}

/** The agent a profile file starts: `agent:`, or its default variant's. */
function profileAgent(profileYaml: string): string | undefined {
  let data: JsonObject | undefined;
  try { data = decodeOptionalBoundary(yaml.load(profileYaml), boundary.jsonObject); }
  catch { return undefined; }
  if (!data) return undefined;
  const direct = text(data.agent);
  if (direct) return direct;
  const variants = decodeOptionalBoundary(data.variants, boundary.jsonObject);
  if (!variants) return undefined;
  const chosen = text(data.default) ?? Object.keys(variants)[0];
  return chosen ? text(decodeOptionalBoundary(variants[chosen], boundary.jsonObject)?.agent) : undefined;
}

/**
 * The Profiles tab's reads and writes (T-63 PR 5), scoped to `<PANE_DIR>/agent-farm/{plugins,drafts,avatars}`.
 * A save is checked with `agent-farm plugin validate` on a staged copy before any file changes, and
 * is then written in place, so a bundled plugin you edit no longer matches its install receipt and
 * Pane updates keep it (A-3). A new profile is installed with `agent-farm plugin install`, which
 * gives it the receipt Agent Farm finds plugins by. Photos sit beside the plugins, in avatars/.
 */
export class ProfileEditor {
  private readonly configRoot: string;

  constructor(private readonly options: ProfileEditorOptions) {
    this.configRoot = agentFarmConfigRoot(options.paneDir);
  }

  private pluginRoot(name: string): string {
    return path.join(this.configRoot, 'plugins', name);
  }

  private bundle(): BundledAgentFarm {
    const bundle = this.options.bundle === undefined ? bundledAgentFarm() : this.options.bundle;
    if (!bundle) throw new PaneError('AGENT_FARM_MISSING', 'This Pane build does not include Agent Farm, so it can\'t check or install profiles.', 'Reinstall Pane from runpane.com.');
    return bundle;
  }

  private async agentFarm(args: string[]): Promise<string> {
    return (this.options.run ?? runAgentFarm)(bundledAgentFarmProcess(this.bundle(), args, this.configRoot));
  }

  /** Installed plugins, by their Agent Farm receipts; Pane's own plain plugin is left out. */
  private async pluginNames(): Promise<string[]> {
    const files = await fs.readdir(path.join(this.configRoot, '.plugins')).catch(() => []);
    const names: string[] = [];
    for (const file of files.filter(entry => entry.endsWith('.json')).sort()) {
      const receipt = await fs.readFile(path.join(this.configRoot, '.plugins', file), 'utf8')
        .then(content => decodeOptionalBoundary(JSON.parse(content), receiptSchema)).catch(() => undefined);
      if (!receipt || receipt.layout !== 2 || file !== `${receipt.name}.json` || receipt.name === PANE_PROFILE_PLUGIN || !PROFILE_NAME_PATTERN.test(receipt.name)) continue;
      names.push(receipt.name);
    }
    return names;
  }

  private async requirePlugin(name: string): Promise<string> {
    checkName(name);
    const root = this.pluginRoot(name);
    const stat = await fs.lstat(root).catch(() => undefined);
    if (!stat?.isDirectory()) throw new PaneError('PROFILE_NOT_FOUND', `There's no profile plugin named ${name} on this computer.`, 'Open Profiles again to see the plugins here.');
    return root;
  }

  /** The files a profile reads: its settings, identity, and what the identity names, following subagents. */
  private async uses(root: string, files: string[], profile: string, entryAgent: string): Promise<string[]> {
    const used = new Set(['plugin.yaml', `profiles/${profile}.yaml`]);
    const visited = new Set<string>();
    const under = (folder: string) => files.filter(file => file.startsWith(`${folder}/`)).forEach(file => used.add(file));
    const visit = async (agent: string): Promise<void> => {
      if (visited.has(agent) || agent.includes('/')) return;
      visited.add(agent);
      const file = `agents/${agent}.md`;
      used.add(file);
      const front = parseFrontmatter(await fs.readFile(path.join(root, file), 'utf8').catch(() => ''));
      if (!front) return;
      for (const instruction of decodeOptionalBoundary(front.data.instructions_files, stringList) ?? []) used.add(path.posix.normalize(path.posix.join('agents', instruction)));
      for (const skill of decodeOptionalBoundary(front.data.skills, stringList) ?? []) if (!skill.includes('/')) under(`skills/${skill}`);
      const references = text(front.data.references);
      if (references && !references.includes('/')) under(`references/${references}`);
      for (const child of Object.values(decodeOptionalBoundary(front.data.subagents, boundary.jsonObject) ?? {})) {
        const childAgent = text(decodeOptionalBoundary(child, boundary.jsonObject)?.agent);
        if (childAgent) await visit(childAgent);
      }
    };
    await visit(entryAgent);
    return [...used].filter(file => files.includes(file)).sort();
  }

  private async readPlugin(name: string): Promise<ProfilePlugin> {
    const root = this.pluginRoot(name);
    const manifest = decodeOptionalBoundary(yaml.load(await fs.readFile(path.join(root, 'plugin.yaml'), 'utf8')), boundary.jsonObject) ?? {};
    const files = await pluginFiles(root);
    const profiles: ProfileSummary[] = [];
    for (const file of files.filter(entry => /^profiles\/[^/]+\.yaml$/.test(entry))) {
      const profile = file.slice('profiles/'.length, -'.yaml'.length);
      const agent = profileAgent(await fs.readFile(path.join(root, file), 'utf8').catch(() => ''));
      if (!agent || !PROFILE_NAME_PATTERN.test(profile)) continue;
      const entry = `agents/${agent}.md`;
      const front = parseFrontmatter(await fs.readFile(path.join(root, entry), 'utf8').catch(() => ''));
      const summary: ProfileSummary = { name: profile, ref: `${name}/${profile}`, entry, harness: text(front?.data.harness) ?? DEFAULT_AGENT_ID, uses: await this.uses(root, files, profile, agent) };
      const model = modelName(front?.data.model);
      if (model) summary.model = model;
      const description = text(front?.data.description);
      if (description) summary.description = description;
      profiles.push(summary);
    }
    const bundled = BUNDLED.includes(name);
    const plugin: ProfilePlugin = {
      name,
      version: text(manifest.version) ?? '',
      bundled,
      edited: bundled && await installedState(this.configRoot, name) === 'edited',
      profiles,
      files,
    };
    const description = text(manifest.description);
    if (description) plugin.description = description;
    return plugin;
  }

  /** Every plugin and profile in this computer's Pane, greenfield and dcouple first. */
  async list(): Promise<ProfilesOverview> {
    const machine = (this.options.machine ?? (() => os.hostname().replace(/\.local$/i, '')))();
    const names = await this.pluginNames();
    const order = (name: string) => (BUNDLED.includes(name) ? BUNDLED.indexOf(name) : BUNDLED.length);
    names.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const plugins: ProfilePlugin[] = [];
    const failed: string[] = [];
    for (const name of names) {
      try { plugins.push(await this.readPlugin(name)); }
      catch (error) { failed.push(`${name} (${reasonOf(error)})`); }
    }
    const overview: ProfilesOverview = { plugins, machine };
    if (failed.length) overview.error = `Pane couldn't read ${failed.join(', ')}. Fix or reinstall the plugin, then open Profiles again.`;
    return overview;
  }

  /** One file of a plugin. */
  async read(plugin: string, relative: string): Promise<string> {
    const root = await this.requirePlugin(plugin);
    const parts = checkRelative(relative);
    await checkNoLinks(root, parts);
    try { return await fs.readFile(path.join(root, ...parts), 'utf8'); }
    catch { throw new PaneError('PROFILE_FILE_MISSING', `${plugin}/${relative} doesn't exist.`, 'Open the profile again to see its files.'); }
  }

  /**
   * Saves files into a plugin: copies it to a staging folder in drafts/, applies the changes there,
   * and has Agent Farm check the result. Only a plugin it accepts is written, file by file in place.
   */
  async save(plugin: string, changes: ProfileFileChange[]): Promise<ProfileSaveResult> {
    const root = await this.requirePlugin(plugin);
    if (!changes.length) return { plugin: await this.readPlugin(plugin), path: '' };
    const checked = changes.map(change => ({ ...change, parts: checkRelative(change.path) }));
    for (const change of checked) await checkNoLinks(root, change.parts);
    const staging = path.join(this.configRoot, 'drafts', `.staging-${plugin}-${randomBytes(4).toString('hex')}`);
    try {
      for (const file of await pluginFiles(root)) {
        await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
        await fs.copyFile(path.join(root, file), path.join(staging, file));
      }
      for (const change of checked) await writeAtomic(path.join(staging, ...change.parts), change.content);
      await withoutPackChecksums(path.join(staging, 'plugin.yaml'));
      await this.validate(staging, plugin);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rmdir(path.join(this.configRoot, 'drafts')).catch(() => undefined);
    }
    for (const change of checked) await writeAtomic(path.join(root, ...change.parts), change.content);
    this.options.onChanged?.(plugin);
    return { plugin: await this.readPlugin(plugin), path: changes[0].path };
  }

  private async validate(folder: string, plugin: string): Promise<void> {
    try {
      await this.agentFarm(['plugin', 'validate', folder]);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const stderr = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr ?? '';
      const reason = (stderr.trim().split('\n').filter(line => line.trim()).at(-1) ?? reasonOf(error)).replace(/^(Error:\s*)+/, '').split(folder).join(plugin);
      throw new PaneError('PROFILE_INVALID', `${plugin} wasn't saved: Agent Farm says ${reason}.`, 'Fix the file, then save again. Nothing was changed.');
    }
  }

  /** A new plugin with one profile and its identity file, installed so Agent Farm finds it. */
  async newProfile(name: string, agent: string): Promise<ProfileSaveResult> {
    checkName(name);
    const harness = plainProfileAgents().find(id => id === agent);
    if (!harness) throw new PaneError('PROFILE_AGENT_INVALID', `Profiles run on ${plainProfileAgents().join(' or ')}, not ${agent}.`, 'Choose one of those.');
    const taken = (await this.pluginNames()).includes(name) || BUNDLED.includes(name) || await fs.lstat(this.pluginRoot(name)).then(() => true, () => false);
    if (taken) throw new PaneError('PROFILE_EXISTS', `A profile plugin named ${name} already exists on this computer.`, 'Choose another name.');
    const model = configuredAgent(harness).chat?.profileModel;
    const files = {
      'plugin.yaml': `name: ${name}\nversion: 0.1.0\ncli_major: 0\n`,
      [`profiles/${name}.yaml`]: `agent: ${name}\n`,
      [`agents/${name}.md`]: ['---', `harness: ${harness}`, ...(model ? ['model:', `  name: ${JSON.stringify(model)}`] : []), `description: ${JSON.stringify(`${titleCase(name)}.`)}`, '---', '', `# ${titleCase(name)}`, '', 'Who you are and what you do.', ''].join('\n'),
    };
    const staging = path.join(this.configRoot, 'drafts', `.new-${name}-${randomBytes(4).toString('hex')}`, name);
    try {
      for (const [relative, content] of Object.entries(files)) await writeAtomic(path.join(staging, ...relative.split('/')), content);
      try { await this.agentFarm(['plugin', 'install', staging]); }
      catch (error) {
        if (error instanceof PaneError) throw error;
        const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
        throw new PaneError('PROFILE_CREATE_FAILED', `Pane couldn't create ${name}: ${reason}.`, 'Try again; if it keeps failing, restart Pane.');
      }
    } finally {
      await fs.rm(path.dirname(staging), { recursive: true, force: true });
      await fs.rmdir(path.join(this.configRoot, 'drafts')).catch(() => undefined);
    }
    this.options.onChanged?.(name);
    return { plugin: await this.readPlugin(name), path: `agents/${name}.md` };
  }

  /** A new subagent, skill or reference file, added to the profile's identity, saved as one change. */
  async newFile(plugin: string, profile: string, kind: ProfileNewFileKind, name: string): Promise<ProfileSaveResult> {
    await this.requirePlugin(plugin);
    checkName(name, kind);
    const summary = (await this.readPlugin(plugin)).profiles.find(entry => entry.name === profile);
    if (!summary) throw new PaneError('PROFILE_NOT_FOUND', `${plugin} has no profile named ${profile}.`, 'Open Profiles again to see its profiles.');
    const identityText = await this.read(plugin, summary.entry);
    const front = parseFrontmatter(identityText);
    if (!front) throw new PaneError('PROFILE_INVALID', `${plugin}/${summary.entry} has no frontmatter to add a ${kind} to.`, 'Fix its frontmatter (between --- lines), then try again.');
    const files = await pluginFiles(this.pluginRoot(plugin));
    let file: string;
    let content: string;
    let lines: string[];
    let entryName = name;
    if (kind === 'subagent') {
      file = `agents/${name}.md`;
      const model = modelName(front.data.model);
      content = ['---', `harness: ${summary.harness}`, ...(model ? [`model: ${JSON.stringify(model)}`] : []), `description: ${JSON.stringify(`${titleCase(name)}, a subagent of ${profile}.`)}`, '---', '', `# ${titleCase(name)}`, '', 'What this subagent does.', ''].join('\n');
      lines = addMapEntry(front.lines, 'subagents', name, [`agent: ${name}`, 'mode: native']);
    } else if (kind === 'skill') {
      file = `skills/${name}/SKILL.md`;
      content = ['---', `name: ${name}`, `description: ${JSON.stringify(`${titleCase(name)}.`)}`, '---', '', 'What this skill does, and when to use it.', ''].join('\n');
      lines = addListItem(front.lines, 'skills', name);
    } else {
      const existing = text(front.data.references);
      if (existing?.includes('/')) throw new PaneError('PROFILE_REFERENCES_SHARED', `${profile} reads its references from ${existing}, another plugin's folder.`, `Add the reference there, or point ${profile} at its own folder first.`);
      const folder = existing ?? profile;
      entryName = folder;
      file = `references/${folder}/${name}.md`;
      content = `# ${titleCase(name)}\n\n`;
      lines = existing ? front.lines : [...front.lines, `references: ${folder}`];
    }
    if (files.includes(file)) throw new PaneError('PROFILE_EXISTS', `${plugin}/${file} already exists.`, 'Choose another name.');
    const identity = editedFrontmatter(front, lines, kind, entryName);
    const changes: ProfileFileChange[] = [{ path: file, content }];
    if (identity !== identityText) changes.push({ path: summary.entry, content: identity });
    return this.save(plugin, changes);
  }

  /** Restore Pane's version (A-3): the bundled copy replaces your edits to greenfield or dcouple. */
  async restore(plugin: string): Promise<ProfileSaveResult> {
    checkName(plugin);
    if (!BUNDLED.includes(plugin)) throw new PaneError('PROFILE_NOT_BUNDLED', `${plugin} doesn't ship with Pane, so there's no Pane version to restore.`, 'Edit it and save instead.');
    try {
      await reinstallBundledPlugin(this.options.paneDir, plugin, this.bundle(), this.options.run);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const reason = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1) || reasonOf(error);
      throw new PaneError('PROFILE_RESTORE_FAILED', `Pane couldn't restore its version of ${plugin}: ${reason}.`, 'Restart Pane, which reinstalls it, then try again.');
    }
    this.options.onChanged?.(plugin);
    const restored = await this.readPlugin(plugin);
    return { plugin: restored, path: restored.profiles[0]?.entry ?? 'plugin.yaml' };
  }

  private photoFile(ref: string): string {
    const [plugin = '', profile = '', extra] = ref.split('/');
    if (extra !== undefined) throw nameError(ref, 'profile');
    checkName(plugin);
    checkName(profile, 'profile');
    return path.join(this.configRoot, 'avatars', `${plugin}--${profile}.png`);
  }

  /** Your photo for a profile on this computer: a PNG, in avatars/, which overrides the plugin's picture. */
  async setPhoto(ref: string, base64: string): Promise<void> {
    const file = this.photoFile(ref);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_PHOTO_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new PaneError('PROFILE_PHOTO_INVALID', 'That photo isn\'t a PNG image of 1 MB or less.', 'Choose another picture.');
    }
    const avatars = path.dirname(file);
    if ((await fs.lstat(avatars).catch(() => undefined))?.isSymbolicLink()) throw new PaneError('PROFILE_PATH_INVALID', 'The avatars folder is a link, which Pane doesn\'t follow.', `Replace ${avatars} with a folder.`);
    await writeAtomic(file, bytes);
  }

  async removePhoto(ref: string): Promise<void> {
    await fs.rm(this.photoFile(ref), { force: true });
  }

  /** Every photo here, and each plugin's own picture (avatar.png at its root), as data URLs. */
  async photos(): Promise<ProfilePhotos> {
    const result: ProfilePhotos = { profiles: {}, plugins: {} };
    const read = async (file: string): Promise<string | undefined> => {
      const stat = await fs.lstat(file).catch(() => undefined);
      if (!stat?.isFile() || stat.size > MAX_PHOTO_BYTES) return undefined;
      const bytes = await fs.readFile(file);
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? `data:image/png;base64,${bytes.toString('base64')}` : undefined;
    };
    const avatars = path.join(this.configRoot, 'avatars');
    for (const entry of await fs.readdir(avatars).catch(() => [])) {
      const match = /^([a-z][a-z0-9_-]*?)--([a-z][a-z0-9_-]*)\.png$/.exec(entry);
      if (!match) continue;
      const data = await read(path.join(avatars, entry));
      if (data) result.profiles[`${match[1]}/${match[2]}`] = data;
    }
    for (const plugin of await this.pluginNames()) {
      const data = await read(path.join(this.pluginRoot(plugin), 'avatar.png'));
      if (data) result.plugins[plugin] = data;
    }
    return result;
  }
}

/**
 * A plugin installed from a pack (greenfield, dcouple) lists its files' checksums in plugin.yaml,
 * which `plugin validate` checks but launches don't. Any edit changes a file, so the staged copy
 * Pane validates leaves them out; the installed plugin.yaml keeps them.
 */
async function withoutPackChecksums(manifestFile: string): Promise<void> {
  const content = await fs.readFile(manifestFile, 'utf8').catch(() => undefined);
  if (content === undefined) return;
  let data: JsonObject | undefined;
  try { data = decodeOptionalBoundary(yaml.load(content), boundary.jsonObject); }
  catch { return; }
  if (!data || !('checksums' in data)) return;
  const { checksums: _packed, ...rest } = data;
  await fs.writeFile(manifestFile, yaml.dump(rest, { lineWidth: -1 }));
}

/** A top-level key's line in frontmatter, and the lines of its block after it. */
function keyBlock(lines: string[], key: string): { index: number; rest: string; end: number } | undefined {
  const index = lines.findIndex(line => new RegExp(`^${key}:(\\s|$)`).test(line));
  if (index < 0) return undefined;
  let end = index + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || /^-\s/.test(lines[end]) || lines[end].trim() === '')) end++;
  while (end > index + 1 && lines[end - 1].trim() === '') end--;
  return { index, rest: lines[index].slice(key.length + 1).trim(), end };
}

/** Adds `- item` to a top-level list, keeping its style, or adds the list. */
function addListItem(lines: string[], key: string, item: string): string[] {
  const block = keyBlock(lines, key);
  if (!block) return [...lines, `${key}:`, `  - ${item}`];
  const next = [...lines];
  if (block.rest.startsWith('[')) {
    const inner = block.rest.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
    next[block.index] = `${key}: [${inner ? `${inner}, ` : ''}${item}]`;
    return next;
  }
  const sample = lines.slice(block.index + 1, block.end).find(line => line.trim().startsWith('-'));
  const indent = sample ? sample.slice(0, sample.indexOf('-')) : '  ';
  next.splice(block.end, 0, `${indent}- ${item}`);
  if (block.rest) next[block.index] = `${key}:`;
  return next;
}

/** Adds `name:` with its fields to a top-level mapping, or adds the mapping. */
function addMapEntry(lines: string[], key: string, name: string, fields: string[]): string[] {
  const block = keyBlock(lines, key);
  if (!block) return [...lines, `${key}:`, `  ${name}:`, ...fields.map(field => `    ${field}`)];
  const next = [...lines];
  const sample = lines.slice(block.index + 1, block.end).find(line => line.trim());
  const indent = sample ? sample.slice(0, sample.length - sample.trimStart().length) : '  ';
  if (block.rest && block.rest !== '{}') return next;
  if (block.rest === '{}') next[block.index] = `${key}:`;
  next.splice(block.end, 0, `${indent}${name}:`, ...fields.map(field => `${indent}${indent}${field}`));
  return next;
}

/**
 * The identity file with its frontmatter edited by lines, so its own formatting stays. When a
 * line edit doesn't parse to what was meant (an unusual layout), the frontmatter is written out
 * again from its data instead.
 */
function editedFrontmatter(front: Frontmatter, lines: string[], kind: ProfileNewFileKind, name: string): string {
  const candidate = renderFrontmatter(lines, front.body);
  const parsed = parseFrontmatter(candidate);
  const has = (data: JsonObject | undefined): boolean => {
    if (!data) return false;
    if (kind === 'skill') return (decodeOptionalBoundary(data.skills, stringList) ?? []).includes(name);
    if (kind === 'subagent') return !!decodeOptionalBoundary(data.subagents, boundary.jsonObject)?.[name];
    return !!text(data.references);
  };
  if (has(parsed?.data)) return candidate;
  const data = { ...front.data };
  if (kind === 'skill') data.skills = [...(decodeOptionalBoundary(data.skills, stringList) ?? []), name];
  else if (kind === 'subagent') data.subagents = { ...decodeOptionalBoundary(data.subagents, boundary.jsonObject), [name]: { agent: name, mode: 'native' } };
  else data.references ??= name;
  return `---\n${yaml.dump(data, { lineWidth: -1 })}---\n${front.body}`;
}
