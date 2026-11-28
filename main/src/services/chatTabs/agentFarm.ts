import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatAgent, ChatPanelState } from '../../../../shared/types/chatTab';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { ChatAgentEnv, ChatProfileResolver } from './launch';
import type { ResolvedLaunch } from './manager';
import { hostCommand, type HostCommand } from '../agentChat/hostCommand';
import { agentConfig } from '../../../../shared/agents';
import type { AgentFarmProcess } from '../agentFarm/bundledAgentFarm';
import { plainProfileAgent } from '../../../../shared/agentProfiles';
import { grantPaneMcp, paneMcpChatServer } from '../paneMcpEndpoint';
import { PANE_MCP_PLUGIN_DENY_SETTINGS } from '../paneMcpNames';

const execFileAsync = promisify(execFile);

/** Agent Farm's `run --print-acp` output (CONFIGURATION.md, "ACP sessions"), the fields Pane uses. */
const printedLaunch = boundary.object({
  /** A configured agent whose chat runs through Pane's bundled adapter. */
  harness: boundary.refine(boundary.string, id => !!agentConfig(id)?.chat?.adapter, 'expected an agent Pane runs through its bundled adapter'),
  argv: boundary.refine(boundary.array(boundary.string), argv => argv.length > 0, 'expected a command'),
  cwd: boundary.string,
  env: boundary.record(boundary.string),
  session: boundary.object({
    cwd: boundary.string,
    mcpServers: boundary.array(boundary.json),
    _meta: boundary.optional(boundary.jsonObject),
  }),
  mode: boundary.optional(boundary.string),
  model: boundary.optional(boundary.string),
});

export interface PrintedAcpLaunch { harness: ChatAgent; launch: ResolvedLaunch }

export interface AgentFarmOptions {
  /** Settings › Advanced › Profiles (T-63): on, only Pane's bundled Agent Farm runs profiles (Q3). */
  profilesOn: () => boolean;
  /**
   * The person's own agent-farm CLI on PATH, which goes first while Profiles is off, as before
   * T-63; undefined when none is on PATH. Not asked while Profiles is on.
   */
  executable: () => string | undefined;
  /**
   * The Agent Farm bundled in Pane, run against Pane's own config root, as a process for `args`
   * in `cwd`; undefined when this build lacks it.
   */
  bundled: (args: string[], cwd: string, env: ChatAgentEnv) => Promise<AgentFarmProcess | undefined>;
  /** The bundled adapter's entry for a harness. */
  adapter: (agent: ChatAgent) => Promise<string>;
  /** Checks the CLI a printed launch will run, in that launch's folder and environment (#1236). */
  checkCli: (agent: ChatAgent, context: { cwd: string; env: ChatAgentEnv }) => Promise<void>;
  /**
   * Puts a Session's profile instructions in its folder (PROFILE.md, which the folder's AGENTS.md
   * includes), where the agent reads them again when it reloads a conversation (T-63).
   */
  sessionProfile: (sessionFolder: string, profile: string, instructions: string) => Promise<void>;
  /** Pane's MCP token for a tab (paneMcpEndpoint.ts); tests pass their own. */
  grantPaneMcp?: typeof grantPaneMcp;
}

/** Agent Farm's own adapter settings (CONFIGURATION.md, "ACP sessions"), which Pane reads and rewrites for a Session. */
const CLAUDE_SYSTEM_PROMPT_META = 'systemPrompt';
const CODEX_CONFIG_ENV = 'CODEX_CONFIG';
const CODEX_INITIAL_MODE_ENV = 'INITIAL_AGENT_MODE';

/**
 * Takes the profile's instructions (with Agent Farm's LAUNCH CONTEXT) out of a printed launch:
 * Claude's system-prompt append, or Codex's developer_instructions. Empty when it has none.
 */
function takeInstructions(launch: ResolvedLaunch): string {
  const parts: string[] = [];
  const prompt = decodeOptionalBoundary(launch.meta?.[CLAUDE_SYSTEM_PROMPT_META], boundary.object({ append: boundary.string }));
  if (prompt && launch.meta) {
    parts.push(prompt.append);
    const { [CLAUDE_SYSTEM_PROMPT_META]: _taken, ...rest } = launch.meta;
    launch.meta = rest;
  }
  const codexConfig = launch.command.env[CODEX_CONFIG_ENV];
  if (codexConfig) {
    let config: JsonObject | undefined;
    try { config = decodeOptionalBoundary(JSON.parse(codexConfig), boundary.jsonObject); }
    catch { config = undefined; }
    const developer = decodeOptionalBoundary(config?.developer_instructions, boundary.string);
    if (config && developer !== undefined) {
      parts.push(developer);
      const { developer_instructions: _taken, ...rest } = config;
      launch.command.env[CODEX_CONFIG_ENV] = JSON.stringify(rest);
    }
  }
  return parts.join('\n\n');
}

/**
 * Pane's plain profiles add nothing, permissions included: the agent asks as it did when Pane
 * started it directly, unless the Session gave it full access (launch.ts fullAccessLaunch).
 */
function plainPermissions(launch: ResolvedLaunch, harness: ChatAgent, fullAccess: boolean): void {
  delete launch.mode;
  delete launch.command.env[CODEX_INITIAL_MODE_ENV];
  if (!fullAccess) return;
  const chat = agentConfig(harness)?.chat;
  if (chat?.fullAccess?.mode) launch.mode = chat.fullAccess.mode;
  else launch.approveOnce = true;
}

/**
 * The CLI a launch runs: the one its environment selects, or the one on PATH. A selected
 * script (a Windows npm shim's cli.js) cannot answer `--version` by itself, so PATH's stands in.
 */
export function printedCli(agent: ChatAgent, env: ChatAgentEnv, lookup: (name: string) => string | null): string | null {
  const config = agentConfig(agent);
  const variable = config?.chat?.adapter?.executableEnv;
  const selected = variable ? env[variable] : undefined;
  return selected && !/\.[cm]?js$/i.test(selected) ? selected : lookup(config?.executables[0] ?? agent);
}

/**
 * Asks Agent Farm for a profile's ACP launch (package 2) at every start, so env
 * (which can carry provider settings) is never saved, and Agent Farm keeps every
 * profile rule: model, effort, instructions with LAUNCH CONTEXT, skills, subagents,
 * MCP servers and telemetry.
 */
export class AgentFarmProfiles implements ChatProfileResolver {
  constructor(private readonly options: AgentFarmOptions) {}

  async resolve(panel: ToolPanel, state: ChatPanelState, env: ChatAgentEnv): Promise<ResolvedLaunch> {
    if (state.launch.kind !== 'profile') throw new PaneError('CHAT_PROFILE_MISSING', 'This chat tab has no Agent Farm profile.', 'Open a new chat tab.');
    const printed = await this.print(state.launch.profile, state.launch.args ?? {}, state.agent, state.cwd, env, state.launch.parent);
    if (printed.harness !== state.agent) {
      throw new PaneError('CHAT_PROFILE_AGENT_CHANGED', `The profile ${state.launch.profile} now runs ${printed.harness}, but this tab was started for ${state.agent}.`, 'Open a new chat tab for the profile.');
    }
    const launch = printed.launch;
    // Profiles off: the launch runs as Agent Farm printed it, as before T-63 (no PROFILE.md, no plain permissions).
    if (!this.options.profilesOn()) return launch;
    if (plainProfileAgent(state.launch.profile)) plainPermissions(launch, printed.harness, state.launch.fullAccess === true);
    if (state.orchestrationSessionId && state.sessionFolder) await this.sessionLaunch(panel, state, state.launch.profile, printed.harness, launch);
    return launch;
  }

  /**
   * A Session's orchestrator (T-63): the profile's instructions move from the launch into the
   * Session folder, where a reloaded conversation reads them again (a launch flag is read only
   * once), and the agent keeps the person's own MCP servers and gets Pane's, as before Agent Farm.
   */
  private async sessionLaunch(panel: ToolPanel, state: ChatPanelState, profile: string, harness: ChatAgent, launch: ResolvedLaunch): Promise<void> {
    const instructions = takeInstructions(launch);
    await this.options.sessionProfile(state.sessionFolder ?? state.cwd, profile, instructions);
    const chat = agentConfig(harness)?.chat;
    const namespace = chat?.adapter?.sessionFolderSettingsMeta;
    const options = namespace ? decodeOptionalBoundary(launch.meta?.[namespace], boundary.object({ options: boundary.jsonObject }))?.options : undefined;
    const paneMcp = chat?.paneMcpHttp ? (this.options.grantPaneMcp ?? grantPaneMcp)({ panelId: panel.id, env: Object.fromEntries(Object.entries(launch.command.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), cwd: launch.command.cwd, agentLabel: agentConfig(harness)?.label ?? harness }) : undefined;
    if (!namespace || (!options && !paneMcp)) return;
    const next: JsonObject = { ...options };
    // Strict MCP would keep only the profile's servers and drop the person's own.
    if (next.strictMcpConfig === true) next.strictMcpConfig = false;
    if (paneMcp) {
      Object.assign(launch.command.env, paneMcp);
      launch.mcpServers = [paneMcpChatServer()];
      // One Pane server: the Claude plugin's own `pane` server steps aside for the HTTP one.
      const settings = decodeOptionalBoundary(next.settings, boundary.jsonObject) ?? {};
      next.settings = { ...settings, ...PANE_MCP_PLUGIN_DENY_SETTINGS };
    }
    launch.meta = { ...launch.meta, [namespace]: { ...decodeOptionalBoundary(launch.meta?.[namespace], boundary.jsonObject), options: next } };
  }

  /**
   * Prints a profile's launch. `agent` picks the adapter to pass; the printed harness is the truth.
   * `parent` (a launch link's parent token) goes to Agent Farm as `--parent` while Profiles is on;
   * with it off, a linked agent's tab doesn't start without its parent (review F-5).
   */
  async print(profile: string, args: Record<string, string>, agent: ChatAgent, cwd: string, env: ChatAgentEnv, parent?: string): Promise<PrintedAcpLaunch> {
    const adapter = await this.options.adapter(agent);
    // Profiles on: Pane's bundled copy only. Off: the person's own agent-farm when one is on PATH,
    // otherwise the bundled copy, as before T-63.
    const profilesOn = this.options.profilesOn();
    if (parent && !profilesOn) {
      throw new PaneError('CHAT_PROFILE_PARENT_OFF', `Profiles is off on this computer, so Pane can't start ${profile} as a linked agent of ${parent}. Nothing was run.`, 'Turn on Profiles in Settings > Advanced > Experimental, then press Retry.');
    }
    const argv = ['run', profile, '--print-acp', '--acp-adapter', adapter, ...Object.entries(args).flatMap(([key, value]) => ['--arg', `${key}=${value}`]), ...(parent ? ['--parent', parent] : [])];
    const cli = profilesOn ? undefined : this.options.executable();
    const bundled = cli ? undefined : await this.options.bundled(argv, cwd, env);
    if (!cli && !bundled) {
      throw profilesOn
        ? new PaneError('CHAT_AGENT_NOT_INSTALLED', 'This Pane build lacks its bundled Agent Farm, so the profile cannot start.', 'Reinstall Pane from runpane.com, then press Retry.')
        : new PaneError('CHAT_AGENT_NOT_INSTALLED', 'Agent Farm is not installed on this machine, and this Pane build lacks its bundled copy, so the profile cannot start.', 'Install the agent-farm CLI, or reinstall Pane from runpane.com, then press Retry.');
    }
    let stdout: string;
    try {
      const command = cli ? agentFarmCommand(cli, argv) : { executable: bundled?.executable ?? '', args: bundled?.args ?? [] };
      ({ stdout } = await execFileAsync(command.executable, command.args, { cwd, env: bundled?.env ?? env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments }));
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const stderr = decodeOptionalBoundary(error, boundary.object({ stderr: boundary.string }))?.stderr.trim().split('\n').at(-1);
      // Agent Farm before package 2 has no --print-acp.
      const outdated = !!stderr && /unknown option.*--print-acp/i.test(stderr);
      throw new PaneError('CHAT_PROFILE_FAILED', `Agent Farm could not prepare ${profile}: ${stderr || reasonOf(error)}.`, outdated ? 'Update Agent Farm to a version with run --print-acp, then try again.' : 'Check the profile name and its launch arguments, then try again.');
    }
    let decoded;
    try { decoded = decodeBoundary(JSON.parse(stdout), printedLaunch); }
    catch (error) { throw new PaneError('CHAT_PROFILE_OUTPUT_INVALID', `Agent Farm's ACP launch for ${profile} was not readable: ${reasonOf(error)}.`, 'Update Agent Farm to a version with run --print-acp, then try again.'); }
    // The contract keeps MCP servers in each harness's own config so secrets stay references.
    if (decoded.session.mcpServers.length) throw new PaneError('CHAT_PROFILE_OUTPUT_INVALID', 'Agent Farm sent MCP servers as ACP session entries, which could carry secrets in plain text.', 'Update Agent Farm, then try again.');
    const [executable, ...rest] = decoded.argv;
    const launchEnv: ChatAgentEnv = { ...env, ...decoded.env };
    // The bundled copy runs on Pane's Electron as Node and prints that runtime as the adapter's
    // Node; without ELECTRON_RUN_AS_NODE it would start another Pane instead of the adapter.
    if (bundled && executable === bundled.executable) launchEnv.ELECTRON_RUN_AS_NODE = '1';
    // Only now is it known which harness and CLI this launch runs, and where.
    await this.options.checkCli(decoded.harness, { cwd: decoded.cwd, env: launchEnv });
    const launch: ResolvedLaunch = { command: { executable, args: rest, cwd: decoded.cwd, env: launchEnv } };
    if (decoded.session._meta) launch.meta = decoded.session._meta;
    if (decoded.mode) launch.mode = decoded.mode;
    return { harness: decoded.harness, launch };
  }
}

/** The agent-farm CLI as a process to start; npm installs it on Windows as a .cmd shim, which runs through cmd. */
export function agentFarmCommand(cli: string, args: string[], platform: NodeJS.Platform = process.platform): HostCommand {
  return hostCommand(cli, args, platform);
}
