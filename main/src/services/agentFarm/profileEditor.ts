import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { DEFAULT_AGENT_ID, configuredAgent } from '../../../../shared/agents';
import { PANE_PROFILE_PLUGIN, plainProfileAgents, profileDisplayName } from '../../../../shared/agentProfiles';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import {
  PROFILE_NAME_PATTERN,
  type ProfileDetails,
  type ProfileFileChange,
  type ProfileNewFileKind,
  type ParsedYaml,
  type ProfilePhotos,
  type ProfilePlugin,
  type ProfileSaveResult,
  type ProfileSubagentNode,
  type ProfileSummary,
  type ProfileTreeNode,
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
import { parseProfileList } from './agentFarmProfiles';

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
  /** Whether a bundled plugin's files still match its receipt; Agent Farm's own check unless a test counts the calls. */
  installedState?: typeof installedState;
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

/**
 * Why an Agent Farm command failed, in one line: its `error:` line (a YAML error prints a code
 * snippet after it, ending in a caret line), else its last line, else `fallback`. Each of `folders` is shown as `shownAs`.
 */
export function agentFarmReason(failure: { stderr: string; fallback: string }, folders: string[] = [], shownAs = ''): string {
  const lines = failure.stderr.split('\n').map(line => line.trim()).filter(Boolean);
  const line = lines.find(entry => /^error:/i.test(entry)) ?? lines.at(-1) ?? failure.fallback;
  let reason = line.replace(/^(error:\s*)+/i, '').replace(/[:.]+$/, '');
  for (const folder of folders) reason = reason.split(folder).join(shownAs);
  // A plugin-relative path reads with / on every system (Windows prints labtest\agents\writer.md).
  return shownAs ? reason.replace(new RegExp(`${shownAs}[\\\\/][^\\s:]*`, 'g'), match => match.split('\\').join('/')) : reason;
}

const stderrSchema = boundary.object({ stderr: boundary.string });

function nameError(name: string, what: string): PaneError {
  return new PaneError('PROFILE_NAME_INVALID', `"${name}" isn't a ${what} name Pane can use.`, 'Use lowercase letters, digits, - and _, starting with a letter.');
}

function checkName(name: string, what = 'plugin'): void {
  if (!PROFILE_NAME_PATTERN.test(name) || (what === 'plugin' && name === PANE_PROFILE_PLUGIN)) throw nameError(name, what);
}

/**
 * TEMPORARY (T-63, test build only): each profile's title from Edit details, in a file of Pane's own
 * in the plugin, which Agent Farm ignores. Profile metadata doesn't live in Pane (the person's rule):
 * before anything merges, the title (and the photo, kept in avatars/ today) move into Agent Farm's
 * profile format (to-do T-83) and this file goes. The description is already Agent Farm's own
 * (`description:` in the identity's front-matter).
 */
const PANE_META_FILE = 'pane.yaml';
/** A profile's cover page, `covers/<profile>.html` or `.md`. Agent Farm ignores the folder. */
const COVER_FILE = /^covers\/([a-z][a-z0-9_-]*)\.(html|md)$/;

/**
 * A plugin-relative path with `/`, checked to stay inside plugin.yaml, the plugin's sections,
 * pane.yaml and the covers folder.
 */
function checkRelative(relative: string): string[] {
  const parts = relative.split('/');
  const inside = relative === 'plugin.yaml' || relative === PANE_META_FILE || COVER_FILE.test(relative) || (SECTIONS.includes(parts[0]) && parts.length > 1);
  if (!inside || path.isAbsolute(relative) || relative.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new PaneError('PROFILE_PATH_INVALID', `"${relative}" isn't a file inside the plugin.`, 'Use a path inside its profiles, agents, skills, instructions or references folder, plugin.yaml, pane.yaml, or covers/<profile>.html.');
  }
  return parts;
}

/** YAML as data for a preview, or why it doesn't parse (with its line). */
export function parseYaml(source: string): ParsedYaml {
  try {
    const data = decodeOptionalBoundary(yaml.load(source), boundary.json);
    return { data: data ?? null };
  } catch (error) {
    const reason = decodeOptionalBoundary(error, boundary.object({ reason: boundary.string }))?.reason ?? reasonOf(error).split('\n')[0];
    const line = decodeOptionalBoundary(error, boundary.object({ mark: boundary.object({ line: boundary.number, column: boundary.number }) }))?.mark;
    return { error: line ? `${reason} at line ${line.line + 1}, column ${line.column + 1}` : reason };
  }
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

/**
 * A plugin file's text for the list, or '' when it is missing or reached through a link: the
 * list reads only what an explicit read would (review F-7).
 */
async function readUnlinked(root: string, relative: string): Promise<string> {
  const parts = relative.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor).catch(() => undefined);
    if (!stat || stat.isSymbolicLink()) return '';
  }
  return fs.readFile(cursor, 'utf8').catch(() => '');
}

async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, file);
}

/**
 * Writes every file, or none (review F-6): when one write fails, the files already written go
 * back to what they held, and a file that was new is removed, so a retry isn't refused as a
 * duplicate. Folders it created under `root` for a new file are removed when empty.
 */
async function writeAllOrNone(root: string, writes: { file: string; content: string }[]): Promise<void> {
  const done: { file: string; before: string | undefined }[] = [];
  try {
    for (const write of writes) {
      const before = await fs.readFile(write.file, 'utf8').catch(() => undefined);
      await writeAtomic(write.file, write.content);
      done.push({ file: write.file, before });
    }
  } catch (error) {
    for (const { file, before } of done.reverse()) {
      if (before !== undefined) await writeAtomic(file, before).catch(() => undefined);
      else {
        await fs.rm(file, { force: true }).catch(() => undefined);
        for (let folder = path.dirname(file); folder.startsWith(`${root}${path.sep}`); folder = path.dirname(folder)) {
          if (!await fs.rmdir(folder).then(() => true, () => false)) break;
        }
      }
    }
    throw error;
  }
}

/** Each file under the given paths (recursively, links not followed) with its size and time, as one string; nothing is read. */
async function fileStamps(paths: string[]): Promise<string> {
  const parts: string[] = [];
  const visit = async (entry: string): Promise<void> => {
    const stat = await fs.lstat(entry).catch(() => undefined);
    if (!stat) { parts.push(`${entry}:-`); return; }
    parts.push(`${entry}:${stat.mtimeMs}:${stat.size}`);
    if (stat.isDirectory()) for (const child of (await fs.readdir(entry).catch(() => [])).sort()) await visit(path.join(entry, child));
  };
  for (const entry of paths) await visit(entry);
  return parts.join('|');
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
  // A section that is itself a link is left out too, as an explicit read of it is refused (review F-7).
  for (const section of SECTIONS) if ((await fs.lstat(path.join(root, section)).catch(() => undefined))?.isDirectory()) await visit(path.join(root, section));
  for (const file of ['plugin.yaml', PANE_META_FILE]) if ((await fs.lstat(path.join(root, file)).catch(() => undefined))?.isFile()) files.push(file);
  for (const child of await fs.readdir(path.join(root, 'covers'), { withFileTypes: true }).catch(() => [])) {
    if (child.isFile() && COVER_FILE.test(`covers/${child.name}`)) files.push(`covers/${child.name}`);
  }
  return files.sort();
}

/** One profile's details in pane.yaml (TEMPORARY, see PANE_META_FILE). */
interface PaneMetaEntry {
  title?: string;
}

/** TEMPORARY (see PANE_META_FILE): each profile's title from pane.yaml (`profiles: { <name>: { title } }`). */
function paneMeta(source: string): Map<string, PaneMetaEntry> {
  const meta = new Map<string, PaneMetaEntry>();
  let data: JsonObject | undefined;
  try { data = decodeOptionalBoundary(yaml.load(source), boundary.jsonObject); }
  catch { return meta; }
  for (const [name, value] of Object.entries(decodeOptionalBoundary(data?.profiles, boundary.jsonObject) ?? {})) {
    const entry = decodeOptionalBoundary(value, boundary.jsonObject);
    if (!entry) continue;
    const details: PaneMetaEntry = {};
    const title = text(entry.title);
    if (title) details.title = title;
    meta.set(name, details);
  }
  return meta;
}

/** Files under `folder`, as nested folder and file nodes (folders first), with ids under `id`. */
function filesAsNodes(files: string[], folder: string, id: string): ProfileTreeNode[] {
  const inside = files.filter(file => file.startsWith(`${folder}/`)).map(file => file.slice(folder.length + 1));
  const folders = [...new Set(inside.filter(file => file.includes('/')).map(file => file.split('/')[0]))].sort();
  const direct = inside.filter(file => !file.includes('/')).sort();
  return [
    ...folders.map((name): ProfileTreeNode => ({ kind: 'folder', id: `${id}/${name}`, label: name, children: filesAsNodes(files, `${folder}/${name}`, `${id}/${name}`) })),
    ...direct.map((name): ProfileTreeNode => ({ kind: 'file', id: `${id}/${name}`, path: `${folder}/${name}`, label: name })),
  ];
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
      const front = parseFrontmatter(await readUnlinked(root, file));
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

  /**
   * A profile's own files, as its page's tree shows them: the identity, then Instructions, Skills
   * (a folder each), References and Subagents (each with its own files nested, once per path so a
   * cycle stops), and at the top level, Settings. `profileOfAgent` names the profile that runs an
   * agent, so a subagent that is also a profile shows that profile's title.
   */
  private async profileTree(root: string, files: string[], agent: string, id: string, context: { plugin: string; profileOfAgent: Map<string, string>; meta: Map<string, PaneMetaEntry>; path: string[] }): Promise<ProfileTreeNode[]> {
    const identity = `agents/${agent}.md`;
    const nodes: ProfileTreeNode[] = [{ kind: 'file', id: `${id}/identity`, path: identity, label: `${agent}.md`, note: 'identity' }];
    const front = parseFrontmatter(await readUnlinked(root, identity));
    if (!front) return nodes;
    const instructions = (decodeOptionalBoundary(front.data.instructions_files, stringList) ?? [])
      .map(file => path.posix.normalize(path.posix.join('agents', file))).filter(file => files.includes(file));
    if (instructions.length) {
      nodes.push({ kind: 'folder', id: `${id}/instructions`, label: 'Instructions', children: instructions.map((file): ProfileTreeNode => ({ kind: 'file', id: `${id}/instructions/${file}`, path: file, label: path.posix.basename(file) })) });
    }
    const skills = (decodeOptionalBoundary(front.data.skills, stringList) ?? []).filter(skill => !skill.includes('/') && files.some(file => file.startsWith(`skills/${skill}/`)));
    if (skills.length) {
      nodes.push({ kind: 'folder', id: `${id}/skills`, label: 'Skills', children: skills.map((skill): ProfileTreeNode => ({ kind: 'folder', id: `${id}/skills/${skill}`, label: skill, children: filesAsNodes(files, `skills/${skill}`, `${id}/skills/${skill}`) })) });
    }
    const references = text(front.data.references);
    if (references && !references.includes('/') && files.some(file => file.startsWith(`references/${references}/`))) {
      nodes.push({ kind: 'folder', id: `${id}/references`, label: 'References', children: filesAsNodes(files, `references/${references}`, `${id}/references`) });
    }
    const subagents: ProfileTreeNode[] = [];
    for (const [alias, binding] of Object.entries(decodeOptionalBoundary(front.data.subagents, boundary.jsonObject) ?? {})) {
      const child = text(decodeOptionalBoundary(binding, boundary.jsonObject)?.agent);
      if (!child || child.includes('/') || !files.includes(`agents/${child}.md`)) continue;
      const childFront = parseFrontmatter(await readUnlinked(root, `agents/${child}.md`));
      const profile = context.profileOfAgent.get(child);
      const ref = profile ? `${context.plugin}/${profile}` : undefined;
      const node: ProfileSubagentNode = {
        kind: 'subagent', id: `${id}/sub:${alias}`, alias, agent: child,
        label: (profile && context.meta.get(profile)?.title) ?? (ref ? profileDisplayName(ref) : titleCase(alias)),
        harness: text(childFront?.data.harness) ?? DEFAULT_AGENT_ID, identity: `agents/${child}.md`,
        children: context.path.includes(child) ? [] : await this.profileTree(root, files, child, `${id}/sub:${alias}`, { ...context, path: [...context.path, child] }),
      };
      const model = modelName(childFront?.data.model);
      if (model) node.model = model;
      const description = text(childFront?.data.description);
      if (description) node.description = description;
      if (ref) node.profile = ref;
      subagents.push(node);
    }
    if (subagents.length) nodes.push({ kind: 'folder', id: `${id}/subagents`, label: 'Subagents', children: subagents });
    return nodes;
  }

  /** What Agent Farm last said about each profile's `listed`, and the profile files it said it for. */
  private listedCache?: { signature: string; listed: Map<string, boolean> };

  /**
   * Which profiles Agent Farm lists (`agent-farm profiles list` prints `| unlisted` for one its
   * plugin hides, such as a subagent's own profile). Asked again only when a profile file or plugin
   * changed, since the tab reads the list every few seconds. An Agent Farm that doesn't print it
   * leaves every profile listed.
   */
  private async listedProfiles(names: string[]): Promise<Map<string, boolean>> {
    const parts: string[] = [];
    for (const name of names) {
      const folder = path.join(this.pluginRoot(name), 'profiles');
      for (const file of (await fs.readdir(folder).catch(() => [])).sort()) {
        const stat = await fs.stat(path.join(folder, file)).catch(() => undefined);
        parts.push(`${name}/${file}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`);
      }
    }
    const signature = parts.join('|');
    if (this.listedCache?.signature === signature) return this.listedCache.listed;
    const listed = new Map<string, boolean>();
    try {
      // The same reading New Session's list uses (parseProfileList): a trailing `| unlisted` marks one.
      for (const entry of parseProfileList(await this.agentFarm(['profiles', 'list']))) listed.set(entry.ref, entry.listed !== false);
    } catch {
      // Agent Farm couldn't list: every profile is shown.
    }
    this.listedCache = { signature, listed };
    return listed;
  }

  /** Each bundled plugin's Edited answer, and the file stamps it was worked out from. */
  private readonly editedCache = new Map<string, { signature: string; edited: boolean }>();

  /**
   * Whether a bundled plugin was changed since Pane installed it. Hashing its files against the
   * receipt reads every one of them, so it is worked out again only when a file's size or time,
   * or the receipt's, changed since the last poll (review F-8).
   */
  private async editedHere(name: string): Promise<boolean> {
    const signature = await fileStamps([this.pluginRoot(name), path.join(this.configRoot, '.plugins', `${name}.json`)]);
    const known = this.editedCache.get(name);
    if (known?.signature === signature) return known.edited;
    const edited = await (this.options.installedState ?? installedState)(this.configRoot, name) === 'edited';
    this.editedCache.set(name, { signature, edited });
    return edited;
  }

  private async readPlugin(name: string): Promise<ProfilePlugin> {
    const root = this.pluginRoot(name);
    const listed = await this.listedProfiles(await this.pluginNames());
    await checkNoLinks(root, ['plugin.yaml']);
    const manifest = decodeOptionalBoundary(yaml.load(await fs.readFile(path.join(root, 'plugin.yaml'), 'utf8')), boundary.jsonObject) ?? {};
    const files = await pluginFiles(root);
    const meta = paneMeta(await readUnlinked(root, PANE_META_FILE));
    const agents = new Map<string, string>();
    for (const file of files.filter(entry => /^profiles\/[^/]+\.yaml$/.test(entry))) {
      const profile = file.slice('profiles/'.length, -'.yaml'.length);
      const agent = profileAgent(await readUnlinked(root, file));
      if (agent && PROFILE_NAME_PATTERN.test(profile)) agents.set(profile, agent);
    }
    const profileOfAgent = new Map<string, string>();
    for (const [profile, agent] of agents) if (!profileOfAgent.has(agent)) profileOfAgent.set(agent, profile);
    const profiles: ProfileSummary[] = [];
    for (const [profile, agent] of agents) {
      const entry = `agents/${agent}.md`;
      const front = parseFrontmatter(await readUnlinked(root, entry));
      const ref = `${name}/${profile}`;
      const tree = await this.profileTree(root, files, agent, profile, { plugin: name, profileOfAgent, meta, path: [agent] });
      const settings = [`profiles/${profile}.yaml`, PANE_META_FILE].filter(file => files.includes(file));
      tree.push({ kind: 'folder', id: `${profile}/settings`, label: 'Settings', children: settings.map((file): ProfileTreeNode => ({ kind: 'file', id: `${profile}/settings/${file}`, path: file, label: path.posix.basename(file) })) });
      const summary: ProfileSummary = {
        name: profile, ref, entry, harness: text(front?.data.harness) ?? DEFAULT_AGENT_ID,
        listed: listed.get(ref) ?? true, uses: await this.uses(root, files, profile, agent), tree,
      };
      const model = modelName(front?.data.model);
      if (model) summary.model = model;
      const details = meta.get(profile);
      // The description is the agent's own (Agent Farm's `description:`); Edit details writes it there.
      const description = text(front?.data.description);
      if (description) summary.description = description;
      if (details?.title) summary.title = details.title;
      const cover = [`covers/${profile}.html`, `covers/${profile}.md`].find(file => files.includes(file));
      if (cover) summary.cover = cover;
      profiles.push(summary);
    }
    const bundled = BUNDLED.includes(name);
    const plugin: ProfilePlugin = {
      name,
      version: text(manifest.version) ?? '',
      bundled,
      edited: bundled && await this.editedHere(name),
      profiles,
      files,
    };
    const description = text(manifest.description);
    if (description) plugin.description = description;
    return plugin;
  }

  /** Every plugin and profile in this computer's Pane, greenfield first. */
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
    await writeAllOrNone(root, checked.map(change => ({ file: path.join(root, ...change.parts), content: change.content })));
    this.options.onChanged?.(plugin);
    return { plugin: await this.readPlugin(plugin), path: changes[0].path };
  }

  private async validate(folder: string, plugin: string): Promise<void> {
    try {
      await this.agentFarm(['plugin', 'validate', folder]);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      // Agent Farm prints the staged folder's real path (/private/var/… on macOS).
      const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) }, [await fs.realpath(folder).catch(() => folder), folder], plugin);
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
        const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) });
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

  /**
   * Edit details. The description is the agent's own Agent Farm field, `description:` in the
   * identity's front-matter: it is edited by line, keeping the rest of the file as it is, and saved
   * like any edit, so Agent Farm checks it (and a bundled plugin becomes Edited). The title goes in
   * pane.yaml, TEMPORARY until Agent Farm has a title field (T-83, see PANE_META_FILE). An empty
   * value removes it.
   */
  async setDetails(plugin: string, profile: string, details: ProfileDetails): Promise<ProfileSaveResult> {
    const root = await this.requirePlugin(plugin);
    checkName(profile, 'profile');
    const summary = (await this.readPlugin(plugin)).profiles.find(entry => entry.name === profile);
    if (!summary) throw new PaneError('PROFILE_NOT_FOUND', `${plugin} has no profile named ${profile}.`, 'Open Profiles again to see its profiles.');
    const identity = await this.read(plugin, summary.entry);
    const front = parseFrontmatter(identity);
    if (!front) throw new PaneError('PROFILE_INVALID', `${plugin}/${summary.entry} has no frontmatter to put a description in.`, 'Fix its frontmatter (between --- lines), then try again.');
    const description = details.description.trim();
    if (description !== (text(front.data.description) ?? '')) await this.save(plugin, [{ path: summary.entry, content: withDescription(front, description) }]);

    // TEMPORARY (T-83): the title, in pane.yaml, until Agent Farm's profile format has one.
    await checkNoLinks(root, [PANE_META_FILE]);
    const file = path.join(root, PANE_META_FILE);
    let data: JsonObject = {};
    const existing = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (existing !== undefined) {
      try { data = decodeOptionalBoundary(yaml.load(existing), boundary.jsonObject) ?? {}; }
      catch (error) { throw new PaneError('PROFILE_INVALID', `${plugin}/pane.yaml doesn't parse: ${reasonOf(error).split('\n')[0]}.`, 'Fix pane.yaml in the profile\'s Settings, then try again.'); }
    }
    const profiles: JsonObject = { ...decodeOptionalBoundary(data.profiles, boundary.jsonObject) };
    const entry: JsonObject = { ...decodeOptionalBoundary(profiles[profile], boundary.jsonObject) };
    const title = details.title.trim();
    if (title) entry.title = title;
    else delete entry.title;
    // An earlier test build kept the description here; it is the identity's now.
    delete entry.description;
    if (Object.keys(entry).length) profiles[profile] = entry;
    else delete profiles[profile];
    const next = yaml.dump({ ...data, profiles }, { lineWidth: -1 });
    if (next !== existing && (existing !== undefined || Object.keys(profiles).length)) await writeAtomic(file, next);
    this.options.onChanged?.(plugin);
    return { plugin: await this.readPlugin(plugin), path: summary.entry };
  }

  /** Restore Pane's version (A-3): the bundled copy replaces your edits to greenfield. */
  async restore(plugin: string): Promise<ProfileSaveResult> {
    checkName(plugin);
    if (!BUNDLED.includes(plugin)) throw new PaneError('PROFILE_NOT_BUNDLED', `${plugin} doesn't ship with Pane, so there's no Pane version to restore.`, 'Edit it and save instead.');
    try {
      await reinstallBundledPlugin(this.options.paneDir, plugin, this.bundle(), this.options.run);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) });
      throw new PaneError('PROFILE_RESTORE_FAILED', `Pane couldn't restore its version of ${plugin}: ${reason}. Your edited copy is as it was.`, 'Restart Pane, then try again.');
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
 * A plugin installed from a pack (greenfield) lists its files' checksums in plugin.yaml,
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

/**
 * The identity with its `description:` set (or removed when empty), changing only that line (or
 * block) so the rest of the file keeps its formatting; when the result wouldn't parse to the new
 * value (an unusual layout), the frontmatter is written out again from its data.
 */
function withDescription(front: Frontmatter, description: string): string {
  const lines = [...front.lines];
  const block = keyBlock(lines, 'description');
  const line = `description: ${JSON.stringify(description)}`;
  if (block) lines.splice(block.index, block.end - block.index, ...(description ? [line] : []));
  else if (description) lines.push(line);
  const candidate = renderFrontmatter(lines, front.body);
  const parsed = parseFrontmatter(candidate);
  if (parsed && (text(parsed.data.description) ?? '') === description) return candidate;
  const data = { ...front.data };
  if (description) data.description = description;
  else delete data.description;
  return `---\n${yaml.dump(data, { lineWidth: -1 })}---\n${front.body}`;
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
