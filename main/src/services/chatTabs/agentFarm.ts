import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatAgent, ChatPanelState } from '../../../../shared/types/chatTab';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { ChatAgentEnv, ChatProfileResolver } from './launch';
import type { ResolvedLaunch } from './manager';
import { hostCommand, type HostCommand } from '../agentChat/hostCommand';
import { agentConfig } from '../../../../shared/agents';

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
  /** The agent-farm CLI; undefined when it is not installed on this machine. */
  executable: () => string | undefined;
  /** The bundled adapter's entry for a harness. */
  adapter: (agent: ChatAgent) => Promise<string>;
  /** Checks the CLI a printed launch will run, in that launch's folder and environment (#1236). */
  checkCli: (agent: ChatAgent, context: { cwd: string; env: ChatAgentEnv }) => Promise<void>;
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

  async resolve(_panel: ToolPanel, state: ChatPanelState, env: ChatAgentEnv): Promise<ResolvedLaunch> {
    if (state.launch.kind !== 'profile') throw new PaneError('CHAT_PROFILE_MISSING', 'This chat tab has no Agent Farm profile.', 'Open a new chat tab.');
    const printed = await this.print(state.launch.profile, state.launch.args ?? {}, state.agent, state.cwd, env);
    if (printed.harness !== state.agent) {
      throw new PaneError('CHAT_PROFILE_AGENT_CHANGED', `The profile ${state.launch.profile} now runs ${printed.harness}, but this tab was started for ${state.agent}.`, 'Open a new chat tab for the profile.');
    }
    return printed.launch;
  }

  /** Prints a profile's launch. `agent` picks the adapter to pass; the printed harness is the truth. */
  async print(profile: string, args: Record<string, string>, agent: ChatAgent, cwd: string, env: ChatAgentEnv): Promise<PrintedAcpLaunch> {
    const cli = this.options.executable();
    if (!cli) throw new PaneError('CHAT_AGENT_NOT_INSTALLED', 'Agent Farm is not installed on this machine, so the profile cannot start.', 'Install the agent-farm CLI, then press Retry.');
    const adapter = await this.options.adapter(agent);
    const argv = ['run', profile, '--print-acp', '--acp-adapter', adapter, ...Object.entries(args).flatMap(([key, value]) => ['--arg', `${key}=${value}`])];
    let stdout: string;
    try {
      const command = agentFarmCommand(cli, argv);
      ({ stdout } = await execFileAsync(command.executable, command.args, { cwd, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments }));
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
    const launchEnv = { ...env, ...decoded.env };
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
