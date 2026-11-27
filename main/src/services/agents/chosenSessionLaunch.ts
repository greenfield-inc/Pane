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

function configurableSession(agent: CliAgentType): AgentSessionConfig | undefined {
  const session = agentConfig(agent)?.terminal.session;
  return session && (session.paneChoosesId || session.selectors !== undefined) ? session : undefined;
}

/**
 * The command's arguments when Pane may add the session flag: it runs the agent directly,
 * starts its interactive UI (no subcommand), picks no conversation itself, and has no `--`,
 * after which the agent reads every word as a message, and no `#` word, after which a shell
 * reads the rest, the added flag included, as a comment.
 */
function extendableArguments(command: string, agent: CliAgentType, session: AgentSessionConfig, platform: NodeJS.Platform): string[] | undefined {
  const args = directAgentArguments(command, agent, platform);
  if (!args || (args.length > 0 && !args[0].startsWith('-'))) return undefined;
  const selectors = new Set([session.flag, ...(session.idFlags ?? []), ...(session.selectors ?? [])]);
  return args.some(word => word === '--' || word.startsWith('#') || selectors.has(word.split('=')[0])) ? undefined : args;
}

/** The id a direct command opens with the session flag (`--flag id` or `--flag=id`), if valid. */
function commandSessionId(command: string, agent: CliAgentType, session: AgentSessionConfig, platform: NodeJS.Platform): string | undefined {
  const args = directAgentArguments(command, agent, platform) ?? [];
  const flags = [session.flag, ...(session.idFlags ?? [])];
  for (let index = 0; index < args.length && args[index] !== '--'; index += 1) {
    const word = args[index];
    for (const flag of flags) {
      const value = word === flag ? args[index + 1] : word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : undefined;
      if (value !== undefined) return isAgentSessionId(agent, value) ? value : undefined;
    }
  }
  return undefined;
}

/** Whether `--resume` can reopen a conversation for this command: Pane will add the session flag to it. */
export function takesChosenSession(command: string, agent: CliAgentType, platform: NodeJS.Platform = process.platform): boolean {
  const session = chosenSession(agent);
  return session !== undefined && extendableArguments(command, agent, session, platform) !== undefined;
}

/** Whether `--resume` can reopen a conversation for an agent whose session flag and selectors live in the config. */
export function takesSessionFlag(command: string, agent: CliAgentType, platform: NodeJS.Platform = process.platform): boolean {
  const session = configurableSession(agent);
  return session !== undefined && extendableArguments(command, agent, session, platform) !== undefined;
}

export interface ChosenSessionLaunch {
  commandToRun: string;
  /** The conversation this launch opens, when Pane knows it. */
  sessionId?: string;
}

export interface SessionFlagLaunchOptions {
  agent: CliAgentType;
  baseCommand: string;
  persistedSessionId?: string;
  allocate: () => string;
  platform?: NodeJS.Platform;
}

/**
 * The command that opens the panel's conversation: the saved id when it is valid, otherwise
 * `allocate()`'s. A command that picks its own conversation, or that Pane can't safely extend
 * (a wrapper, shell syntax, a subcommand), runs unchanged. Undefined for an agent without a
 * Pane-chosen session.
 */
export function resolveChosenSessionLaunch(options: SessionFlagLaunchOptions): ChosenSessionLaunch | undefined {
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

/**
 * Launch resolution for any agent whose session flag and selectors live in the config:
 * allocates an id up front when `paneChoosesId` is set, or starts bare and adds `session.flag`
 * once the CLI's own conversation id has been captured.
 */
export function resolveSessionFlagLaunch(options: SessionFlagLaunchOptions): ChosenSessionLaunch | undefined {
  if (chosenSession(options.agent)) return resolveChosenSessionLaunch(options);
  const { agent, baseCommand, persistedSessionId } = options;
  const platform = options.platform ?? process.platform;
  const session = configurableSession(agent);
  if (!session) return undefined;
  if (!extendableArguments(baseCommand, agent, session, platform)) {
    return { commandToRun: baseCommand, sessionId: commandSessionId(baseCommand, agent, session, platform) };
  }
  const saved = persistedSessionId?.trim();
  if (!isAgentSessionId(agent, saved)) return { commandToRun: baseCommand, sessionId: undefined };
  return { commandToRun: `${baseCommand.trimEnd()} ${session.flag} ${saved}`, sessionId: saved };
}

/** Reads the last conversation id printed at TUI exit for an agent whose config defines `exitIdPattern`. */
export function extractExitSessionId(agent: CliAgentType | undefined, cleanText: string): string | undefined {
  const session = agent ? agentConfig(agent)?.terminal.session : undefined;
  if (!agent || !session?.exitIdPattern) return undefined;
  const candidate = Array.from(cleanText.matchAll(new RegExp(session.exitIdPattern, 'gmu'))).at(-1)?.[1];
  return isAgentSessionId(agent, candidate) ? candidate : undefined;
}
