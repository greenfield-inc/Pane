import fs from 'fs/promises';
import path from 'path';
import { CONFIGURED_AGENT_IDS, agentConfig, configuredAgent, type ConfiguredAgentId } from '../../../../shared/agents';
import type { AgentFarmProfileEntry, AgentFarmProfileVariant } from '../../../../shared/types/agentFarmProfiles';
import { hashDirectory } from '../skillCacheManager';

/**
 * Pane's own Agent Farm plugin (T-63): one profile per agent Agent Farm runs, holding only its
 * harness and model, so a Session started without a profile still runs through Agent Farm and
 * adds nothing of Agent Farm's (no identity, skills or subagents). Pane writes it from its agents
 * contract (`chat.profileModel`) and owns it: an edit there is replaced at the next start.
 */
export const PANE_PROFILE_PLUGIN = 'pane';
const PANE_PROFILE_PLUGIN_VERSION = '1.0.0';

/** The agents with a plain profile: those whose config names an Agent Farm model. */
export function plainProfileAgents(): ConfiguredAgentId[] {
  return CONFIGURED_AGENT_IDS.filter(id => !!configuredAgent(id).chat?.profileModel);
}

/** `pane/<agent>`, the plain profile of an agent, or undefined when Agent Farm doesn't run it. */
export function plainProfileRef(agent: string): string | undefined {
  return agentConfig(agent)?.chat?.profileModel ? `${PANE_PROFILE_PLUGIN}/${agent}` : undefined;
}

/** The agent of a plain profile ref (`pane/claude` → claude), or undefined for any other profile. */
export function plainProfileAgent(ref: string): ConfiguredAgentId | undefined {
  const [plugin, rest] = ref.split('/');
  if (plugin !== PANE_PROFILE_PLUGIN || !rest) return undefined;
  const agent = rest.split(':')[0];
  return plainProfileAgents().find(id => id === agent);
}

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

/**
 * One line of `agent-farm profiles list` (Agent Farm 0.2), for example
 * `greenfield/planner (claude: claude-opus-5-5 high · codex: gpt-6-astra high) -> planner | plugin greenfield 0.0.46 | claude | claude-opus-5-5 high | native default`.
 * The harness and model are the default variant's. Undefined for a line in another shape.
 */
export function parseProfileListLine(line: string): AgentFarmProfileEntry | undefined {
  const fields = line.trim().split(' | ');
  if (fields.length < 4) return undefined;
  const head = /^([a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*)(?: \((.*)\))? -> \S+/.exec(fields[0]);
  const plugin = /^plugin (\S+) (\S+)$/.exec(fields[1]);
  const harness = fields[2].trim();
  if (!head || !plugin || !harness) return undefined;
  const [model, effort] = fields[3].trim().split(/\s+/);
  const entry: AgentFarmProfileEntry = { ref: head[1], plugin: plugin[1], version: plugin[2], harness, hidden: plugin[1] === PANE_PROFILE_PLUGIN };
  if (model) entry.model = model;
  if (effort && effort !== 'default') entry.effort = effort;
  const variants = head[2]?.split(' · ').map(part => /^([a-z][a-z0-9_-]*): (\S+)(?: (\S+))?/.exec(part)).filter(match => !!match)
    .map(match => {
      const variant: AgentFarmProfileVariant = { name: match[1], model: match[2] };
      if (match[3]) variant.effort = match[3];
      return variant;
    });
  if (variants?.length) {
    entry.variants = variants;
    entry.defaultVariant = variants[0].name;
  }
  return entry;
}

/** Every profile `agent-farm profiles list` printed, in its order. */
export function parseProfileList(stdout: string): AgentFarmProfileEntry[] {
  return stdout.split('\n').map(parseProfileListLine).filter((entry): entry is AgentFarmProfileEntry => !!entry);
}
