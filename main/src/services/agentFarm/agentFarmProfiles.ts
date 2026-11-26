import fs from 'fs/promises';
import path from 'path';
import { configuredAgent } from '../../../../shared/agents';
import { PANE_PROFILE_PLUGIN, plainProfileAgents } from '../../../../shared/agentProfiles';
import type { AgentFarmProfileEntry, AgentFarmProfileVariant } from '../../../../shared/types/agentFarmProfiles';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { hashDirectory } from '../skillCacheManager';

/**
 * Pane's own Agent Farm plugin (T-63): one profile per agent Agent Farm runs, holding only its
 * harness and model, so a Session started without a profile still runs through Agent Farm and
 * adds nothing of Agent Farm's (no identity, skills or subagents). Pane writes it from its agents
 * contract (`chat.profileModel`) and owns it: an edit there is replaced at the next start.
 */
const PANE_PROFILE_PLUGIN_VERSION = '1.0.0';

/** Pane's plugin's source files, relative path (with `/`) → content, as `agent-farm plugin install` takes them. */
export function panePluginFiles(): Map<string, string> {
  const files = new Map([['plugin.yaml', `name: ${PANE_PROFILE_PLUGIN}\nversion: ${PANE_PROFILE_PLUGIN_VERSION}\ncli_major: 0\n`]]);
  for (const agent of plainProfileAgents()) {
    const config = configuredAgent(agent);
    files.set(`profiles/${agent}.yaml`, `agent: ${agent}\n`);
    files.set(`agents/${agent}.md`, [
      '---',
      `harness: ${agent}`,
      'model:',
      `  name: ${JSON.stringify(config.chat?.profileModel)}`,
      `description: ${JSON.stringify(`${config.title} on its own, as Pane starts a Session without a profile.`)}`,
      '---',
      '',
    ].join('\n'));
  }
  return files;
}

/** Whether `plugins/pane` holds exactly the files Pane writes, so an edit there is noticed at start. */
export async function panePluginInstalled(configRoot: string): Promise<boolean> {
  const root = path.join(configRoot, 'plugins', PANE_PROFILE_PLUGIN);
  const expected = panePluginFiles();
  const found: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    for (const child of await fs.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, child.name);
      if (child.isDirectory()) await visit(full);
      else found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  try { await visit(root); }
  catch { return false; }
  if (found.length !== expected.size) return false;
  for (const relative of found) {
    const content = expected.get(relative);
    if (content === undefined || await fs.readFile(path.join(root, relative), 'utf8').catch(() => undefined) !== content) return false;
  }
  return true;
}

/** Writes the plugin's source into `directory`, replacing whatever was there. */
export async function writePanePluginSource(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
  for (const [relative, content] of panePluginFiles()) {
    const file = path.join(directory, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/**
 * The content hash of an installed plugin (every file under `plugins/<name>`), which a Session
 * records with its profile so a later save can be told apart. Undefined when it isn't installed.
 */
export async function installedPluginHash(configRoot: string, plugin: string): Promise<string | undefined> {
  if (!/^[a-z][a-z0-9_-]*$/.test(plugin)) return undefined;
  try { return await hashDirectory(path.join(configRoot, 'plugins', plugin)); }
  catch { return undefined; }
}

/** The plugin a profile ref belongs to. */
export function profilePlugin(ref: string): string {
  return ref.split('/')[0];
}

/** The listing's shape version Pane reads (`profiles list --json`'s top-level `schema`). */
const PROFILE_LIST_SCHEMA = 1;

const modelSchema = boundary.object({ name: boundary.optional(boundary.nullable(boundary.string)), reasoning: boundary.optional(boundary.nullable(boundary.string)) });

/** A model as Agent Farm's listing gives it. */
export type AgentFarmListedModel = ReturnType<typeof modelSchema.decode>;

/** One link in a profile's tree (CONFIGURATION.md, `profiles list --json`). */
export interface AgentFarmListedLink {
  alias: string;
  agent?: string;
  mode: 'native' | 'process' | 'launch';
  variant?: string;
  variants?: string[];
  default?: string;
  description?: string;
  command?: string;
  cycle?: boolean;
  any?: boolean;
  plugin?: string;
  error?: string;
  children: AgentFarmListedLink[];
}

const optionalText = boundary.optional(boundary.nullable(boundary.string));
const anyLink: BoundarySchema<AgentFarmListedLink> = { decode: cursor => linkSchema.decode(cursor) };
const linkSchema: BoundarySchema<AgentFarmListedLink> = {
  decode: cursor => {
    const link = boundary.object({
      alias: boundary.string,
      agent: optionalText,
      mode: boundary.enumeration('native', 'process', 'launch'),
      variant: optionalText,
      variants: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
      default: optionalText,
      description: optionalText,
      command: optionalText,
      cycle: boundary.optional(boundary.boolean),
      any: boundary.optional(boundary.boolean),
      plugin: optionalText,
      error: optionalText,
      children: boundary.optional(boundary.array(anyLink)),
    }).decode(cursor);
    const result: AgentFarmListedLink = { alias: link.alias, mode: link.mode, children: link.children ?? [] };
    for (const key of ['agent', 'variant', 'default', 'description', 'command', 'plugin', 'error'] as const) {
      const value = link[key];
      if (value) result[key] = value;
    }
    if (link.variants?.length) result.variants = link.variants;
    if (link.cycle) result.cycle = true;
    if (link.any) result.any = true;
    return result;
  },
};

const variantSchema = boundary.object({ agent: boundary.string, harness: boundary.string, model: boundary.optional(boundary.nullable(modelSchema)) });

const listedProfileSchema = boundary.object({
  ref: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  plugin: boundary.nonEmptyString,
  version: boundary.string,
  title: optionalText,
  description: optionalText,
  photo: optionalText,
  sources: boundary.optional(boundary.nullable(boundary.object({ title: optionalText, photo: optionalText }))),
  variants: boundary.optional(boundary.nullable(boundary.record(variantSchema))),
  default: optionalText,
  agent: optionalText,
  harness: optionalText,
  model: boundary.optional(boundary.nullable(modelSchema)),
  tree: boundary.optional(boundary.nullable(boundary.array(linkSchema))),
  error: optionalText,
});

/** One entry of `agent-farm profiles list --json`; one that failed to resolve has `error` and its identity only. */
export type AgentFarmListedProfile = ReturnType<typeof listedProfileSchema.decode>;

/**
 * `agent-farm profiles list --json` (Agent Farm 0.3, T-83): every profile, with its title,
 * description, SVG photo, variants and the tree of agents it links to. Throws a PaneError when the
 * output is not that listing (an older Agent Farm, or a newer schema).
 */
export function parseProfileListJson(stdout: string): AgentFarmListedProfile[] {
  let data: JsonValue;
  try { data = decodeBoundary(JSON.parse(stdout), boundary.json); }
  catch { throw new PaneError('AGENT_FARM_LIST_UNREADABLE', 'Agent Farm\'s profiles list --json printed something other than JSON.', 'Restart Pane, which reinstalls its bundled Agent Farm, then try again.'); }
  const schema = decodeOptionalBoundary(data, boundary.object({ schema: boundary.number }))?.schema;
  if (schema !== PROFILE_LIST_SCHEMA) {
    throw new PaneError('AGENT_FARM_LIST_UNREADABLE', `Agent Farm's profiles list --json printed schema ${schema ?? 'none'}, and this Pane reads schema ${PROFILE_LIST_SCHEMA}.`, 'Update Pane, then try again.');
  }
  // A profile with no title of its own is listed under its name (`sources.title: default`); Pane makes a better one from the ref.
  try { return decodeBoundary(data, boundary.object({ profiles: boundary.array(listedProfileSchema) })).profiles.map(entry => (entry.sources?.title === 'default' ? { ...entry, title: undefined } : entry)); }
  catch (error) { throw new PaneError('AGENT_FARM_LIST_UNREADABLE', `Agent Farm's profiles list --json wasn't readable: ${reasonOf(error)}.`, 'Restart Pane, which reinstalls its bundled Agent Farm, then try again.'); }
}

/** The default variant's agent, harness and model of a listed profile (a single-agent profile's own). */
export function listedDefault(profile: AgentFarmListedProfile): { agent?: string; harness?: string; model?: AgentFarmListedModel | null } {
  const variants = profile.variants ? Object.entries(profile.variants) : [];
  const chosen = variants.find(([name]) => name === profile.default) ?? variants[0];
  return chosen ? { agent: chosen[1].agent, harness: chosen[1].harness, model: chosen[1].model } : { agent: profile.agent ?? undefined, harness: profile.harness ?? undefined, model: profile.model };
}

/**
 * The agents a listing's trees link to, as names they start by (`plugin/agent`, and `plugin/alias` when
 * the alias differs), or `plugin/*` for a link that may start any agent in its plugin (T-83 P3).
 */
export function linkedAgentRefs(profiles: AgentFarmListedProfile[]): string[] {
  const refs = new Set<string>();
  const walk = (links: readonly AgentFarmListedLink[], plugin: string) => {
    for (const link of links) {
      const own = link.plugin ?? plugin;
      if (link.any) refs.add(`${own}/*`);
      // Agent Farm 0.3.0 lists agent as plugin/agent already.
      if (link.agent) refs.add(link.agent.includes('/') ? link.agent : `${own}/${link.agent}`);
      if (link.mode === 'launch' && link.alias && !link.any) refs.add(`${own}/${link.alias}`);
      walk(link.children, own);
    }
  };
  for (const profile of profiles) walk(profile.tree ?? [], profile.plugin);
  return [...refs];
}

/** New Session's and the profile picker's entries: every listed profile that resolved, in Agent Farm's order. */
export function profileListEntries(profiles: AgentFarmListedProfile[]): AgentFarmProfileEntry[] {
  return profiles.flatMap((profile): AgentFarmProfileEntry[] => {
    const chosen = listedDefault(profile);
    if (profile.error || !chosen.harness) return [];
    const entry: AgentFarmProfileEntry = { ref: profile.ref, plugin: profile.plugin, version: profile.version, harness: chosen.harness, hidden: profile.plugin === PANE_PROFILE_PLUGIN };
    if (chosen.model?.name) entry.model = chosen.model.name;
    if (chosen.model?.reasoning) entry.effort = chosen.model.reasoning;
    if (profile.title) entry.title = profile.title;
    if (profile.description) entry.description = profile.description;
    const variants = Object.entries(profile.variants ?? {});
    if (variants.length) {
      // Agent Farm lists the default first.
      entry.defaultVariant = profile.default ?? variants[0][0];
      entry.variants = variants.map(([name, variant]) => {
        const item: AgentFarmProfileVariant = { name, model: variant.model?.name ?? '' };
        if (variant.model?.reasoning) item.effort = variant.model.reasoning;
        return item;
      });
    }
    return [entry];
  });
}

