import path from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { databaseService } from './database';
import { panelManager } from './panelManager';
import {
  getPaneChatPanelId,
  ONBOARDING_HANDOFF_PREFERENCE,
  PANE_CHAT_MIGRATE_OFFER_OPENING,
  type PaneChatAgent,
} from '../../../shared/types/paneChat';
import type { TerminalPanelState } from '../../../shared/types/panels';

/**
 * The Onboarding Session speaks first exactly once per Pane data folder, with
 * the task the first-run screen's answer gives it: migrate the agent sessions
 * the person said yes to, or write a Start here page for the project they
 * opened. Without an answer (every install from before that screen) it awaits
 * the user, as the Session context says.
 */
export const MIGRATE_OFFER_PREFERENCE = 'pane_chat_migrate_offer_sent';

const PANE_CHAT_AGENTS: readonly PaneChatAgent[] = ['claude', 'codex', 'cursor'];

/** Whether two paths name the same folder, ignoring case on Windows. */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * The prompt counts as sent once any Pane Chat terminal launched with it. The
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
export function paneIsEmpty(): boolean {
  if (databaseService.getAllSessions().length > 0) return false;
  const sampleRepository = path.join(getAppDirectory(), 'projects', 'Pane');
  return databaseService.getAllProjects().every(project => samePath(project.path, sampleRepository));
}

function migrateSkillPath(skillsRoot: string | undefined): string {
  // SkillCacheManager installs the bundle here; it is absent only in tests.
  const root = skillsRoot ?? path.join(getAppDirectory(), 'skills', 'pane-chat', 'skills');
  return path.join(root, 'migrate-to-pane', 'SKILL.md');
}

function migratePrompt(skillPath: string): string {
  return [
    `${PANE_CHAT_MIGRATE_OFFER_OPENING} on Pane's first-run screen the person said Yes to bringing in their agent sessions that are running or were active in the last 7 days.`,
    `That Yes is their confirmation. Follow the Migrate to Pane skill (${skillPath}) now, on its first-run path: show no list and ask nothing first.`,
    'It ends with the Start here page beside this chat.',
  ].join(' ');
}

function startHerePrompt(skillPath: string): string {
  const projects = databaseService.getAllProjects();
  const opened = projects.length > 0
    ? `They opened ${projects.map(project => `${project.name} (${project.path})`).join(', ')}.`
    : 'They have not opened a project yet.';
  return [
    `${PANE_CHAT_MIGRATE_OFFER_OPENING} on Pane's first-run screen the person said Not now to bringing in agent sessions, or Pane found none. ${opened}`,
    `Follow "Start here without a migration" in the Migrate to Pane skill (${skillPath}): make their Start here page and open it beside this chat. Bring no sessions in.`,
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
  const handoff = databaseService.getUserPreference(ONBOARDING_HANDOFF_PREFERENCE);
  if (handoff !== 'migrate' && handoff !== 'project') return undefined;
  if (offerAlreadySent() || resumesConversation(agent, previous)) return undefined;
  const skillPath = migrateSkillPath(skillsRoot);
  return handoff === 'migrate' ? migratePrompt(skillPath) : startHerePrompt(skillPath);
}
