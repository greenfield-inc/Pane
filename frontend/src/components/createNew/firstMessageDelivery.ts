import { agentConfig, agentLabel, agentTerminalCommand, isConfiguredAgent } from '../../../../shared/agents';
import { isStandardCustomResume, type CustomCommandResume } from '../../../../shared/types/customCommandResume';
import type { SessionRuntimes } from '../../../../shared/types/orchestrationSession';

/**
 * Whether Create New (T-63) can deliver a Session's first message before it creates the Session:
 * text rides on the create as an opening prompt, images go through the new Session's chat. When it
 * can't, Create stays off and the draft stays as it is, with the reason on screen.
 */
export interface FirstMessageTarget {
  /** The Session runs on the machine the app is on. */
  here: boolean;
  /** The Run on machine's name, for the reasons. */
  machineName: string;
  /** What that machine said about its runtimes; null while it is being read, `{}` when it couldn't say. */
  runtimes: SessionRuntimes | Partial<SessionRuntimes> | null;
  /** Chat tabs on this computer; for `here`, the setting that decides. */
  chatTabsHere: boolean;
  wsl: boolean;
  agent: string;
  /** The Session starts an Agent Farm profile, which always runs in a chat. */
  profile: boolean;
  /** The launch command and custom resume the create sends, after Create New's defaults. */
  launchCommand: string;
  customResume: CustomCommandResume | null;
}

/**
 * Whether the Session opens in a chat tab, as main's `sessionChatLaunch` decides. A launch command
 * other than the agent's own is taken as a terminal: only main can say whether a chat runs it.
 */
export function opensInChat(target: FirstMessageTarget): boolean {
  const chatTabs = target.here ? target.chatTabsHere : target.runtimes?.chatTabs === true;
  if (!chatTabs || target.wsl) return false;
  if (target.profile) return true;
  if (!agentConfig(target.agent)?.chat) return false;
  if (target.customResume && !isStandardCustomResume(target.customResume)) return false;
  const command = target.launchCommand.trim();
  return !command || (isConfiguredAgent(target.agent) && command === agentTerminalCommand(target.agent));
}

/** Why images can't go with the first message there, or undefined when they can. */
export function imagesBlocked(target: FirstMessageTarget): string | undefined {
  if (!target.here) return 'Images can be attached when the Session runs on this computer. Pick it in Run on, or attach them in the Session\'s chat.';
  if (!target.chatTabsHere) return 'Images go to a chat tab. Turn on Chat tabs in Settings › AI & Agents to attach them.';
  if (target.wsl) return 'A Session in WSL runs in a terminal, which takes no images. Set Run agent in to Windows in More options, or remove them.';
  if (!opensInChat(target)) {
    const why = !agentConfig(target.agent)?.chat ? `${agentLabel(target.agent)} runs in a terminal` : 'its launch settings run it in a terminal';
    return `This Session can't take images: ${why}, which takes no images. Pick an agent that runs in a chat, or remove them.`;
  }
  return undefined;
}

/** Why the text of the first message can't be delivered there, or undefined when it can. */
export function textBlocked(target: FirstMessageTarget): string | undefined {
  if (opensInChat(target) || target.wsl) return undefined;
  if (target.runtimes === null) return `Checking how ${target.here ? 'this computer' : target.machineName} starts a Session's agent…`;
  // A Pane from before T-63 doesn't say; it is sent as before.
  if (target.runtimes.promptAtLaunch !== false) return undefined;
  const where = target.here ? 'On this computer' : `On ${target.machineName}`;
  return `${where} this Session starts in a terminal whose shell (PowerShell or cmd) can't take a first message. Turn on Chat tabs in Settings › AI & Agents${target.here ? '' : ` on ${target.machineName}`}, or create it without one and send the message once it opens.`;
}
