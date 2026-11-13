import { PaneError } from '../../../../shared/paneError';
import { agentConfig, isAgentSessionId, type AgentSessionConfig } from '../../../../shared/agents';
import { directAgentArguments, type CliAgentType } from './agentIdentity';

/**
 * Agents whose session flag also creates the conversation (`terminal.session.paneChoosesId`
 * in the agents config, for example `pi --session-id <id>`). Pane picks the id, saves it as the
 * panel's `agentSessionId` and runs the same command on the first launch and every relaunch.
 */
function chosenSession(agent: CliAgentType): AgentSessionConfig | undefined {
  const session = agentConfig(agent)?.terminal.session;
  return session?.paneChoosesId ? session : undefined;
}

/**
 * The command's arguments when Pane may add the session flag: it runs the agent directly,
 * starts its interactive UI (no subcommand), picks no conversation itself and has no `--`,
 * after which the agent reads every word as a message.
 */
function extendableArguments(command: string, agent: CliAgentType, session: AgentSessionConfig, platform: NodeJS.Platform): string[] | undefined {
  const args = directAgentArguments(command, agent, platform);
  if (!args || (args.length > 0 && !args[0].startsWith('-'))) return undefined;
  const selectors = new Set([session.flag, ...(session.selectors ?? [])]);
  return args.some(word => word === '--' || selectors.has(word.split('=')[0])) ? undefined : args;
}

/** The id a direct command opens with the session flag (`--flag id` or `--flag=id`), if valid. */
function commandSessionId(command: string, agent: CliAgentType, session: AgentSessionConfig, platform: NodeJS.Platform): string | undefined {
  const args = directAgentArguments(command, agent, platform) ?? [];
  for (let index = 0; index < args.length && args[index] !== '--'; index += 1) {
    const word = args[index];
    const value = word === session.flag ? args[index + 1] : word.startsWith(`${session.flag}=`) ? word.slice(session.flag.length + 1) : undefined;
    if (value !== undefined) return isAgentSessionId(agent, value) ? value : undefined;
  }
  return undefined;
}

/** Whether `--resume` can reopen a conversation for this command: Pane will add the session flag to it. */
export function takesChosenSession(command: string, agent: CliAgentType, platform: NodeJS.Platform = process.platform): boolean {
  const session = chosenSession(agent);
  return session !== undefined && extendableArguments(command, agent, session, platform) !== undefined;
}

export interface ChosenSessionLaunch {
  commandToRun: string;
  /** The conversation this launch opens, when Pane knows it. */
  sessionId?: string;
}

/**
 * The command that opens the panel's conversation: the saved id when it is valid, otherwise
 * `allocate()`'s. A command that picks its own conversation, or that Pane can't safely extend
 * (a wrapper, shell syntax, a subcommand), runs unchanged. Undefined for an agent without a
 * Pane-chosen session.
 */
export function resolveChosenSessionLaunch(options: {
  agent: CliAgentType;
  baseCommand: string;
  persistedSessionId?: string;
  allocate: () => string;
  platform?: NodeJS.Platform;
}): ChosenSessionLaunch | undefined {
  const { agent, baseCommand, persistedSessionId, allocate } = options;
  const platform = options.platform ?? process.platform;
  const session = chosenSession(agent);
  if (!session) return undefined;
  if (!extendableArguments(baseCommand, agent, session, platform)) {
    return { commandToRun: baseCommand, sessionId: commandSessionId(baseCommand, agent, session, platform) };
  }
  const saved = persistedSessionId?.trim();
  const sessionId = isAgentSessionId(agent, saved) ? saved : allocate();
  if (!isAgentSessionId(agent, sessionId)) {
    const label = agentConfig(agent)?.label ?? agent;
    throw new PaneError(
      'ERR_AGENT_SESSION_ID',
      `${label} session id "${sessionId}" does not match ${session.idPattern}, so ${label} was not launched.`,
      `Resume the tab with a valid ${label} session id, or start a new ${label} tab.`,
    );
  }
  return { commandToRun: `${baseCommand.trimEnd()} ${session.flag} ${sessionId}`, sessionId };
}
