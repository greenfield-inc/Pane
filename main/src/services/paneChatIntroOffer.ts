import { databaseService } from './database';
import { isAgentSupportedOnPlatform } from '../../../shared/constants/agentLaunchPresets';
import { LEGACY_ORCHESTRATION_SESSION_ID, type OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { PaneChatAgent } from '../../../shared/types/paneChat';

/**
 * Pane offers Pane Chat once, to someone running Panes by hand: after at least
 * two worktree Panes and three days of use, unless they already made a Session.
 * The renderer sets this preference when the offer first shows.
 */
export const INTRO_OFFER_PREFERENCE = 'pane_chat_intro_offer_shown';

const MIN_WORKTREE_PANES = 2;
const MIN_ACTIVE_DAYS = 3;

/** Visible Panes the user made; Pane Chat's and Sessions' own terminals are hidden. */
const VISIBLE_PANE = 'COALESCE(is_hidden, 0) = 0';

/** SQLite's CURRENT_TIMESTAMP is UTC without a zone; ISO values already carry one. */
function localDay(timestamp: string): string {
  const at = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

function worktreePaneCount(): number {
  // SAFETY: This fixed SQLite query projection matches the declared row type at this database boundary.
  const row = databaseService.getDb()
    .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${VISIBLE_PANE} AND COALESCE(is_main_repo, 0) = 0`)
    .get() as { count: number };
  return row.count;
}

/** Local calendar days Pane was launched or a Pane was created, so days the app stayed open count too. */
function activeDayCount(): number {
  // SAFETY: This fixed SQLite query projection matches the declared row type at this database boundary.
  const rows = databaseService.getDb()
    .prepare(`SELECT opened_at AS at FROM app_opens UNION ALL SELECT created_at AS at FROM sessions WHERE ${VISIBLE_PANE}`)
    .all() as Array<{ at: string | null }>;
  return new Set(rows.flatMap(row => row.at ? [localDay(row.at)] : [])).size;
}

/**
 * Whether this install should see the Pane Chat offer now. `sessions` are all
 * Session records, archived included; `agent` is the configured Pane Chat agent.
 */
export function paneChatIntroOfferEligible(sessions: readonly OrchestrationSessionRecord[], agent: PaneChatAgent): boolean {
  if (databaseService.getUserPreference(INTRO_OFFER_PREFERENCE) === 'true') return false;
  if (sessions.some(session => session.id !== LEGACY_ORCHESTRATION_SESSION_ID)) return false;
  if (!isAgentSupportedOnPlatform(agent, process.platform)) return false;
  return worktreePaneCount() >= MIN_WORKTREE_PANES && activeDayCount() >= MIN_ACTIVE_DAYS;
}
