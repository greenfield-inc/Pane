import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { configuredAgent } from '../../../../shared/agents';
import { PANE_PROFILE_PLUGIN, plainProfileAgents } from '../../../../shared/agentProfiles';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import {
  PROFILE_NAME_PATTERN,
  MAX_PROFILE_PHOTO_BYTES,
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
  withoutPackChecksums,
} from './bundledAgentFarm';
import { listedDefault, parseProfileListJson, type AgentFarmListedLink, type AgentFarmListedProfile } from './agentFarmProfiles';
import { forgetSyncedEdit, syncedPluginEdits } from './profileSyncFile';
import { dismissRecovery, pendingRecoveries, recoveryFolder } from './agentFarmRecovery';

/** The folders of a plugin Agent Farm reads, besides plugin.yaml (Agent Farm's plugins.js). */
const SECTIONS = ['profiles', 'agents', 'skills', 'instructions', 'references'];
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
  /**
   * Runs a change to `plugin` under profile sync's lock and records it before letting go, so a save
   * here never interleaves with one arriving from another computer (T-63 PR 6, review F-2).
   */
  exclusive?: <T>(plugin: string, work: () => Promise<T>) => Promise<T>;
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

/** A profile's cover page, `covers/<profile>.html` or `.md`. Agent Farm ignores the folder. */
const COVER_FILE = /^covers\/([a-z][a-z0-9_-]*)\.(html|md)$/;

/**
 * A plugin-relative path with `/`, checked to stay inside plugin.yaml, the plugin's sections and
 * the covers folder.
 */
export function checkRelative(relative: string): string[] {
  const parts = relative.split('/');
  const inside = relative === 'plugin.yaml' || COVER_FILE.test(relative) || (SECTIONS.includes(parts[0]) && parts.length > 1);
  if (!inside || path.isAbsolute(relative) || relative.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new PaneError('PROFILE_PATH_INVALID', `"${relative}" isn't a file inside the plugin.`, 'Use a path inside its profiles, agents, skills, instructions or references folder, plugin.yaml, or covers/<profile>.html.');
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

export async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
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
  for (const file of ['plugin.yaml']) if ((await fs.lstat(path.join(root, file)).catch(() => undefined))?.isFile()) files.push(file);
  for (const child of await fs.readdir(path.join(root, 'covers'), { withFileTypes: true }).catch(() => [])) {
    if (child.isFile() && COVER_FILE.test(`covers/${child.name}`)) files.push(`covers/${child.name}`);
  }
  return files.sort();
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

/** Installed plugins in an Agent Farm config root, by their receipts, sorted; Pane's own plain plugin is left out. */
async function installedPluginNames(configRoot: string): Promise<string[]> {
  const files = await fs.readdir(path.join(configRoot, '.plugins')).catch(() => []);
  const names: string[] = [];
  for (const file of files.filter(entry => entry.endsWith('.json')).sort()) {
    const receipt = await fs.readFile(path.join(configRoot, '.plugins', file), 'utf8')
      .then(content => decodeOptionalBoundary(JSON.parse(content), receiptSchema)).catch(() => undefined);
    if (!receipt || receipt.layout !== 2 || file !== `${receipt.name}.json` || receipt.name === PANE_PROFILE_PLUGIN || !PROFILE_NAME_PATTERN.test(receipt.name)) continue;
    names.push(receipt.name);
  }
  return names;
}

/**
 * The Profiles tab's reads and writes (T-63 PR 5), scoped to `<PANE_DIR>/agent-farm/{plugins,drafts}`.
 * A save is checked with `agent-farm plugin validate` on a staged copy before any file changes, and
 * is then written in place, so a bundled plugin you edit no longer matches its install receipt and
 * Pane updates keep it (A-3). A new profile is installed with `agent-farm plugin install`, which
 * gives it the receipt Agent Farm finds plugins by. What a profile is and shows (its title,
 * description, SVG photo and the agents it links to) is Agent Farm's `profiles list --json`
 * (T-83); title, description and photo edits go through `agent-farm profiles set`.
 */
export class ProfileEditor {
  private readonly configRoot: string;

  constructor(private readonly options: ProfileEditorOptions) {
    this.configRoot = agentFarmConfigRoot(options.paneDir);
  }

  /** A change to `plugin`, under profile sync's lock when there is one (`exclusive`). */
  private guard<T>(plugin: string, work: () => Promise<T>): Promise<T> {
    return this.options.exclusive ? this.options.exclusive(plugin, work) : work();
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
  private pluginNames(): Promise<string[]> {
    return installedPluginNames(this.configRoot);
  }

  private async requirePlugin(name: string): Promise<string> {
    checkName(name);
    const root = this.pluginRoot(name);
    const stat = await fs.lstat(root).catch(() => undefined);
    if (!stat?.isDirectory()) throw new PaneError('PROFILE_NOT_FOUND', `There's no profile plugin named ${name} on this computer.`, 'Open Profiles again to see the plugins here.');
    return root;
  }

  /**
   * The identity file in `root` of an agent ref of `plugin` (`plugin/agent`): `agents/<agent>.md`,
   * or for a variant set (`agents/<agent>.yaml`) its default member's file. Undefined for another
   * plugin's agent or one whose file isn't there.
   */
  private async identityOf(root: string, files: string[], plugin: string, ref: string | undefined): Promise<string | undefined> {
    const [owner, agent, extra] = (ref ?? '').split('/');
    if (owner !== plugin || !agent || extra !== undefined) return undefined;
    if (files.includes(`agents/${agent}.md`)) return `agents/${agent}.md`;
    if (!files.includes(`agents/${agent}.yaml`)) return undefined;
    let data: JsonObject | undefined;
    try { data = decodeOptionalBoundary(yaml.load(await readUnlinked(root, `agents/${agent}.yaml`)), boundary.jsonObject); }
    catch { return undefined; }
    const variants = decodeOptionalBoundary(data?.variants, boundary.jsonObject) ?? {};
    const chosen = text(data?.default) ?? Object.keys(variants)[0];
    const member = chosen ? text(decodeOptionalBoundary(variants[chosen], boundary.jsonObject)?.agent) : undefined;
    return member && !member.includes('/') && files.includes(`agents/${member}.md`) ? `agents/${member}.md` : undefined;
  }

  /**
   * An agent's own files, as its page's tree shows them: the identity, then Instructions, Skills (a
   * folder each) and References, read from its front-matter. The agents it links to come from Agent
   * Farm's listing (`links`), as Subagents, each with its own files and links nested (T-83: Pane no
   * longer follows `subagents:` itself; Agent Farm stops the tree at a cycle and marks it).
   */
  private async profileTree(root: string, files: string[], identity: string | undefined, links: AgentFarmListedLink[], id: string, context: { plugin: string; profileOfAgent: Map<string, AgentFarmListedProfile> }): Promise<ProfileTreeNode[]> {
    const nodes: ProfileTreeNode[] = [];
    const front = identity ? parseFrontmatter(await readUnlinked(root, identity)) : undefined;
    if (identity) nodes.push({ kind: 'file', id: `${id}/identity`, path: identity, label: path.posix.basename(identity), note: 'identity' });
    if (front) {
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
    }
    const subagents: ProfileTreeNode[] = [];
    for (const link of links) subagents.push(await this.linkNode(root, files, link, `${id}/sub:${link.alias}`, context));
    if (subagents.length) nodes.push({ kind: 'folder', id: `${id}/subagents`, label: 'Subagents', children: subagents });
    return nodes;
  }

  /** One linked agent of Agent Farm's tree, with its own files and links nested (none for a cycle, an `any` link or an error). */
  private async linkNode(root: string, files: string[], link: AgentFarmListedLink, id: string, context: { plugin: string; profileOfAgent: Map<string, AgentFarmListedProfile> }): Promise<ProfileSubagentNode> {
    const agentRef = link.agent ?? link.plugin ?? '';
    const identity = link.any ? undefined : await this.identityOf(root, files, context.plugin, link.agent);
    const front = identity ? parseFrontmatter(await readUnlinked(root, identity)) : undefined;
    const profile = link.agent ? context.profileOfAgent.get(link.agent) : undefined;
    const node: ProfileSubagentNode = {
      kind: 'subagent', id, alias: link.alias, agent: agentRef, mode: link.mode,
      label: profile?.title ?? titleCase(link.alias),
      children: link.cycle || link.any || link.error ? [] : await this.profileTree(root, files, identity, link.children, id, context),
    };
    const harness = text(front?.data.harness);
    if (harness) node.harness = harness;
    const model = modelName(front?.data.model);
    if (model) node.model = model;
    const description = link.description ?? text(front?.data.description);
    if (description) node.description = description;
    if (link.variants?.length) node.variants = link.variants;
    else if (link.variant) node.variants = [link.variant];
    if (link.command) node.command = link.command;
    if (link.cycle) node.cycle = true;
    if (link.any) node.any = true;
    if (link.error) node.error = link.error;
    if (profile) node.profile = profile.ref;
    if (identity) node.identity = identity;
    return node;
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

  /** Agent Farm's listing, and the plugin and override files it was read for. */
  private listingCache?: { signature: string; profiles: AgentFarmListedProfile[] };

  /**
   * Every profile, as `agent-farm profiles list --json` lists it (T-83). Asked again only when a
   * plugin file or a display override changed, since the tab reads the list every few seconds.
   */
  private async listing(names: string[]): Promise<AgentFarmListedProfile[]> {
    const parts: string[] = [];
    const stamp = async (file: string, shown: string) => {
      const stat = await fs.stat(file).catch(() => undefined);
      parts.push(`${shown}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`);
    };
    for (const name of names) for (const file of await pluginFiles(this.pluginRoot(name))) await stamp(path.join(this.pluginRoot(name), file), `${name}/${file}`);
    const overrides = path.join(this.configRoot, 'profile-overrides');
    for (const plugin of (await fs.readdir(overrides).catch(() => [])).sort()) {
      for (const file of (await fs.readdir(path.join(overrides, plugin)).catch(() => [])).sort()) await stamp(path.join(overrides, plugin, file), `overrides/${plugin}/${file}`);
    }
    const signature = parts.join('|');
    if (this.listingCache?.signature === signature) return this.listingCache.profiles;
    let profiles: AgentFarmListedProfile[];
    try { profiles = parseProfileListJson(await this.agentFarm(['profiles', 'list', '--json'])); }
    catch (error) {
      if (error instanceof PaneError) throw error;
      const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) });
      throw new PaneError('AGENT_FARM_LIST_FAILED', `Agent Farm couldn't list the profiles: ${reason}.`, 'Restart Pane, then open Profiles again.');
    }
    this.listingCache = { signature, profiles };
    return profiles;
  }

  private async readPlugin(name: string, listed?: AgentFarmListedProfile[], failed: string[] = []): Promise<ProfilePlugin> {
    const root = this.pluginRoot(name);
    await checkNoLinks(root, ['plugin.yaml']);
    const all = listed ?? await this.listing(await this.pluginNames());
    const manifest = decodeOptionalBoundary(yaml.load(await fs.readFile(path.join(root, 'plugin.yaml'), 'utf8')), boundary.jsonObject) ?? {};
    const files = await pluginFiles(root);
    const mine = all.filter(entry => entry.plugin === name);
    // A linked agent that a profile of this plugin also runs shows that profile's title and photo.
    const profileOfAgent = new Map<string, AgentFarmListedProfile>();
    for (const entry of mine) {
      const agent = listedDefault(entry).agent;
      if (agent && !profileOfAgent.has(agent)) profileOfAgent.set(agent, entry);
    }
    const profiles: ProfileSummary[] = [];
    for (const entry of mine) {
      const chosen = listedDefault(entry);
      if (entry.error || !chosen.harness) {
        failed.push(`${entry.ref} (${entry.error ?? 'no agent'})`);
        continue;
      }
      const identity = await this.identityOf(root, files, name, chosen.agent);
      const tree = await this.profileTree(root, files, identity, entry.tree ?? [], entry.name, { plugin: name, profileOfAgent });
      const settings = [`profiles/${entry.name}.yaml`].filter(file => files.includes(file));
      tree.push({ kind: 'folder', id: `${entry.name}/settings`, label: 'Settings', children: settings.map((file): ProfileTreeNode => ({ kind: 'file', id: `${entry.name}/settings/${file}`, path: file, label: path.posix.basename(file) })) });
      const summary: ProfileSummary = { name: entry.name, ref: entry.ref, entry: identity ?? '', harness: chosen.harness, tree };
      if (chosen.model?.name) summary.model = chosen.model.name;
      if (entry.title) summary.title = entry.title;
      if (entry.description) summary.description = entry.description;
      const variants = Object.keys(entry.variants ?? {});
      if (variants.length) summary.variants = variants;
      const cover = [`covers/${entry.name}.html`, `covers/${entry.name}.md`].find(file => files.includes(file));
      if (cover) summary.cover = cover;
      profiles.push(summary);
    }
    const bundled = BUNDLED.includes(name);
    const plugin: ProfilePlugin = {
      name,
      version: text(manifest.version) ?? '',
      bundled,
      edited: bundled && (await this.editedHere(name) || (await syncedPluginEdits(this.configRoot)).has(name)),
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
    let listed: AgentFarmListedProfile[];
    try { listed = await this.listing(names); }
    catch (error) { return { plugins: [], machine, error: reasonOf(error) }; }
    const plugins: ProfilePlugin[] = [];
    const failed: string[] = [];
    for (const name of names) {
      try { plugins.push(await this.readPlugin(name, listed, failed)); }
      catch (error) { failed.push(`${name} (${reasonOf(error)})`); }
    }
    const overview: ProfilesOverview = { plugins, machine };
    if (failed.length) overview.error = `Pane couldn't read ${failed.join(', ')}. Fix or reinstall the plugin, then open Profiles again.`;
    const recovered = await pendingRecoveries(this.configRoot);
    if (recovered.length) overview.recovered = recovered;
    return overview;
  }

  /** Hides one recovery's notice for good (#1740 review F-3); its saved files stay. */
  dismissRecovery(id: string): Promise<void> {
    return dismissRecovery(this.configRoot, id);
  }

  /** The folder a recovery's edited copy is saved in, for Open folder. */
  recoveryFolder(id: string): Promise<string> {
    return recoveryFolder(this.configRoot, id);
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
  save(plugin: string, changes: ProfileFileChange[]): Promise<ProfileSaveResult> {
    return this.guard(plugin, () => this.saveNow(plugin, changes));
  }

  private async saveNow(plugin: string, changes: ProfileFileChange[]): Promise<ProfileSaveResult> {
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
  newProfile(name: string, agent: string): Promise<ProfileSaveResult> {
    return this.guard(name, () => this.newProfileNow(name, agent));
  }

  private async newProfileNow(name: string, agent: string): Promise<ProfileSaveResult> {
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
  newFile(plugin: string, profile: string, kind: ProfileNewFileKind, name: string): Promise<ProfileSaveResult> {
    return this.guard(plugin, () => this.newFileNow(plugin, profile, kind, name));
  }

  private async newFileNow(plugin: string, profile: string, kind: ProfileNewFileKind, name: string): Promise<ProfileSaveResult> {
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
   * Edit details (T-83): the title and description go through `agent-farm profiles set`, which keeps
   * them as Agent Farm's own display override in the config root, so they survive Pane reinstalling
   * the plugin on an update and a bundled plugin doesn't become Edited. Only a field that changed is
   * sent; an empty one goes back to the plugin's own.
   */
  setDetails(plugin: string, profile: string, details: ProfileDetails): Promise<ProfileSaveResult> {
    return this.guard(plugin, () => this.setDetailsNow(plugin, profile, details));
  }

  private async setDetailsNow(plugin: string, profile: string, details: ProfileDetails): Promise<ProfileSaveResult> {
    const summary = await this.requireProfile(plugin, profile);
    const args: string[] = [];
    const title = details.title.trim();
    const description = details.description.trim();
    if (title !== (summary.title ?? '')) args.push('--title', title);
    if (description !== (summary.description ?? '')) args.push('--description', description);
    if (args.length) await this.setDisplay(summary.ref, args);
    return { plugin: await this.readPlugin(plugin), path: summary.entry };
  }

  /** A profile of an installed plugin, as Agent Farm lists it. */
  private async requireProfile(plugin: string, profile: string): Promise<ProfileSummary> {
    await this.requirePlugin(plugin);
    checkName(profile, 'profile');
    const summary = (await this.readPlugin(plugin)).profiles.find(entry => entry.name === profile);
    if (!summary) throw new PaneError('PROFILE_NOT_FOUND', `${plugin} has no profile named ${profile}.`, 'Open Profiles again to see its profiles.');
    return summary;
  }

  /** `agent-farm profiles set REF …`; Agent Farm checks the values (a photo's SVG) and says why it refuses one. */
  private async setDisplay(ref: string, args: string[]): Promise<void> {
    try {
      await this.agentFarm(['profiles', 'set', ref, ...args]);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) }, [path.join(this.configRoot, 'drafts')], 'drafts');
      throw new PaneError('PROFILE_DETAILS_REFUSED', `${ref} wasn't changed: Agent Farm says ${reason}.`, 'Fix it, then save again. Nothing was changed.');
    }
    this.options.onChanged?.(ref.split('/')[0]);
  }

  /** Restore Pane's version (A-3): the bundled copy replaces your edits to greenfield. Your titles, descriptions and photos stay. */
  restore(plugin: string): Promise<ProfileSaveResult> {
    return this.guard(plugin, () => this.restoreNow(plugin));
  }

  private async restoreNow(plugin: string): Promise<ProfileSaveResult> {
    checkName(plugin);
    if (!BUNDLED.includes(plugin)) throw new PaneError('PROFILE_NOT_BUNDLED', `${plugin} doesn't ship with Pane, so there's no Pane version to restore.`, 'Edit it and save instead.');
    try {
      await reinstallBundledPlugin(this.options.paneDir, plugin, this.bundle(), this.options.run);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const reason = agentFarmReason({ stderr: decodeOptionalBoundary(error, stderrSchema)?.stderr ?? '', fallback: reasonOf(error) });
      throw new PaneError('PROFILE_RESTORE_FAILED', `Pane couldn't restore its version of ${plugin}: ${reason}. Your edited copy is as it was.`, 'Restart Pane, then try again.');
    }
    await forgetSyncedEdit(this.configRoot, plugin);
    this.options.onChanged?.(plugin);
    const restored = await this.readPlugin(plugin);
    return { plugin: restored, path: restored.profiles[0]?.entry ?? 'plugin.yaml' };
  }

  /**
   * Your photo for a profile (T-83): an SVG, which Agent Farm checks (at most 64 KB, shapes and
   * text only, nothing it would load or run) and keeps as its own display override.
   */
  setPhoto(ref: string, svg: string): Promise<void> {
    return this.guard(ref.split('/')[0], () => this.setPhotoNow(ref, svg));
  }

  private async setPhotoNow(ref: string, svg: string): Promise<void> {
    const [plugin = '', profile = '', extra] = ref.split('/');
    if (extra !== undefined) throw nameError(ref, 'profile');
    await this.requireProfile(plugin, profile);
    if (Buffer.byteLength(svg, 'utf8') > MAX_PROFILE_PHOTO_BYTES) throw new PaneError('PROFILE_PHOTO_INVALID', `That photo is larger than ${MAX_PROFILE_PHOTO_BYTES / 1024} KB, the most a profile photo can be.`, 'Choose a smaller SVG.');
    if (!/<svg[\s>]/i.test(svg)) throw new PaneError('PROFILE_PHOTO_INVALID', 'That photo isn\'t an SVG image. Profile photos are SVG only.', 'Choose an SVG file.');
    const folder = path.join(this.configRoot, 'drafts', `.photo-${randomBytes(4).toString('hex')}`);
    try {
      await writeAtomic(path.join(folder, `${profile}.svg`), svg);
      await this.setDisplay(ref, ['--photo', path.join(folder, `${profile}.svg`)]);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
      await fs.rmdir(path.join(this.configRoot, 'drafts')).catch(() => undefined);
    }
  }

  /** Removes your photo: the plugin's own shows again, or the initials when it has none. */
  removePhoto(ref: string): Promise<void> {
    return this.guard(ref.split('/')[0], () => this.removePhotoNow(ref));
  }

  private async removePhotoNow(ref: string): Promise<void> {
    const [plugin = '', profile = '', extra] = ref.split('/');
    if (extra !== undefined) throw nameError(ref, 'profile');
    await this.requireProfile(plugin, profile);
    await this.setDisplay(ref, ['--photo', '']);
  }

  /**
   * Every profile's photo here, as an SVG data URL, and whether it is yours or the plugin's (Agent
   * Farm's listing). A file that is gone or larger than Agent Farm allows is left out.
   */
  async photos(): Promise<ProfilePhotos> {
    const result: ProfilePhotos = { profiles: {}, sources: {} };
    let listed: AgentFarmListedProfile[];
    try { listed = await this.listing(await this.pluginNames()); }
    catch { return result; }
    for (const entry of listed) {
      if (!entry.photo || entry.error) continue;
      const stat = await fs.stat(entry.photo).catch(() => undefined);
      if (!stat?.isFile() || stat.size > MAX_PROFILE_PHOTO_BYTES) continue;
      const bytes = await fs.readFile(entry.photo).catch(() => undefined);
      if (!bytes) continue;
      result.profiles[entry.ref] = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
      // A local profile's own file (`file`) is yours as much as an override is.
      result.sources[entry.ref] = entry.sources?.photo === 'plugin' ? 'plugin' : 'yours';
    }
    return result;
  }
}

/**
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
