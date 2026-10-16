import path from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { databaseService } from './database';
import { panelManager } from './panelManager';
import { getPaneChatPanelId, type PaneChatAgent } from '../../../shared/types/paneChat';
import type { TerminalPanelState } from '../../../shared/types/panels';

/**
 * Pane Chat speaks first exactly once per Pane data folder: on its first
 * launch while Pane has no Panes and no repositories, it asks whether to bring
 * the user's existing agent sessions into Pane. Every other launch awaits the
 * user, as the Session context says.
 */
export const MIGRATE_OFFER_PREFERENCE = 'pane_chat_migrate_offer_sent';

const PANE_CHAT_AGENTS: readonly PaneChatAgent[] = ['claude', 'codex', 'cursor'];

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * The offer counts as sent once any Pane Chat terminal launched with it. The
 * launch records that as `initialInputSentAt`, which a later rebuild of the
 * launch state clears, so it is copied into the preference the first time it
 * is seen.
 */
function offerAlreadySent(): boolean {
  if (databaseService.getUserPreference(MIGRATE_OFFER_PREFERENCE) === 'true') return true;
  const sent = PANE_CHAT_AGENTS.some(agent => {
    // SAFETY: Pane Chat panels persist TerminalPanelState as their custom state.
    const state = panelManager.getPanel(getPaneChatPanelId(agent))?.state.customState as TerminalPanelState | undefined;
    return Boolean(state?.initialInput?.trim() && state.initialInputSentAt);
  });
  if (sent) databaseService.setUserPreference(MIGRATE_OFFER_PREFERENCE, 'true');
  return sent;
}

/** A launch that resumes a conversation passes no first prompt. */
function resumesConversation(agent: PaneChatAgent, state: TerminalPanelState | undefined): boolean {
  if (state?.agentType !== undefined && state.agentType !== agent) return false;
  return agent === 'claude' ? state?.hasClaudeSessionId === true : Boolean(state?.agentSessionId);
}

/** No Panes, and no repositories other than the sample one onboarding clones. */
function paneIsEmpty(): boolean {
  if (databaseService.getAllSessions().length > 0) return false;
  const sampleRepository = path.join(getAppDirectory(), 'projects', 'Pane');
  return databaseService.getAllProjects().every(project => samePath(project.path, sampleRepository));
}

function migrateOfferText(skillsRoot: string | undefined): string {
  // SkillCacheManager installs the bundle here; it is absent only in tests.
  const root = skillsRoot ?? path.join(getAppDirectory(), 'skills', 'pane-chat', 'skills');
  const skillPath = path.join(root, 'migrate-to-pane', 'SKILL.md');
  return [
    'Pane sent this once, the first time Pane Chat started with this Pane data folder: there are no repositories or Panes yet.',
    'Ask the user, briefly, whether they want to bring their existing agent sessions into Pane.',
    `The Migrate to Pane skill (${skillPath}) finds sessions from Claude Code, Codex, OpenCode, Cursor, Conductor or anything similar, opens each in a Pane tab, and resumes it exactly where it was.`,
    'Don\'t start until they say yes. If they say no, tell them they can say "migrate to Pane" any time.',
  ].join(' ');
}

/**
 * The first prompt for a Pane Chat terminal about to launch with `agent`, or
 * undefined when it should wait for the user. `previous` is the panel's
 * current launch state, if it has one.
 */
export function paneChatFirstPrompt(
  agent: PaneChatAgent,
  previous: TerminalPanelState | undefined,
  skillsRoot: string | undefined,
): string | undefined {
  if (offerAlreadySent() || resumesConversation(agent, previous) || !paneIsEmpty()) return undefined;
  return migrateOfferText(skillsRoot);
}
