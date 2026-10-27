import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ORCHESTRATION_SESSION_ID, type OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { databaseService } from './database';
import { INTRO_OFFER_PREFERENCE, paneChatIntroOfferEligible } from './paneChatIntroOffer';

const originalTimeZone = process.env.TZ;
const originalPlatform = process.platform;

function pane(id: string, createdAt: string, flags: { mainRepo?: boolean; hidden?: boolean; archived?: boolean } = {}): void {
  databaseService.createSession({
    id,
    name: id,
    initial_prompt: '',
    worktree_name: id,
    worktree_path: `/repo/worktrees/${id}`,
    project_id: null,
    is_hidden: flags.hidden ?? false,
  });
  databaseService.getDb().prepare('UPDATE sessions SET created_at = ?, is_main_repo = ?, archived = ? WHERE id = ?')
    .run(createdAt, flags.mainRepo ? 1 : 0, flags.archived ? 1 : 0, id);
}

function opened(...timestamps: string[]): void {
  for (const at of timestamps) databaseService.getDb().prepare('INSERT INTO app_opens (opened_at) VALUES (?)').run(at);
}

function sessionRecord(id: string, archived = false): OrchestrationSessionRecord {
  // SAFETY: Eligibility reads only a record's id; the rest of the record is irrelevant here.
  return { id, archived } as OrchestrationSessionRecord;
}

const builtInPaneChatOnly = [sessionRecord(LEGACY_ORCHESTRATION_SESSION_ID)];

beforeEach(() => {
  process.env.TZ = 'UTC';
  const db = databaseService.getDb();
  db.prepare('DELETE FROM user_preferences WHERE key = ?').run(INTRO_OFFER_PREFERENCE);
  db.prepare('DELETE FROM app_opens').run();
  db.prepare('DELETE FROM sessions WHERE id != ?').run(PANE_CHAT_SESSION_ID);
});

afterEach(() => {
  process.env.TZ = originalTimeZone;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

describe('Pane Chat offer eligibility', () => {
  it('offers Pane Chat after two worktree Panes and three days of use', () => {
    pane('first', '2026-10-20 09:00:00');
    pane('second', '2026-10-21 09:00:00');
    opened('2026-10-20 08:00:00');
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(false);

    opened('2026-10-22 08:00:00');
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(true);
  });

  it('counts a day Pane stayed open and a Pane was created, and archived Panes', () => {
    pane('first', '2026-10-20 09:00:00', { archived: true });
    pane('second', '2026-10-22 09:00:00');
    opened('2026-10-21 08:00:00');
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(true);
  });

  it('does not count main-repo Panes or hidden internal terminals as worktree Panes', () => {
    pane('worktree', '2026-10-20 09:00:00');
    pane('main', '2026-10-21 09:00:00', { mainRepo: true });
    pane('internal', '2026-10-21 09:00:00', { hidden: true });
    opened('2026-10-22 08:00:00', '2026-10-23 08:00:00');
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(false);
  });

  it('needs three days: two worktree Panes used on two days are not enough', () => {
    pane('first', '2026-10-20 09:00:00');
    pane('second', '2026-10-21 09:00:00');
    opened('2026-10-20 07:00:00', '2026-10-21 23:00:00');
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(false);
  });

  it('counts days in local time, not UTC', () => {
    // UTC days: Oct 20, 21, 22. Los Angeles (UTC-7) days: Oct 20 and 22 only.
    pane('first', '2026-10-20 16:00:00');
    pane('second', '2026-10-21 02:00:00');
    opened('2026-10-21 06:00:00', '2026-10-22 12:00:00');
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(true);
    process.env.TZ = 'America/Los_Angeles';
    expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(false);
  });

  describe('with an otherwise eligible install', () => {
    beforeEach(() => {
      pane('first', '2026-10-20 09:00:00');
      pane('second', '2026-10-21 09:00:00');
      opened('2026-10-22 08:00:00');
    });

    it('never offers it to someone who already made a Session, archived or not', () => {
      expect(paneChatIntroOfferEligible([...builtInPaneChatOnly, sessionRecord('__orchestration_session_x__', true)], 'claude')).toBe(false);
    });

    it('offers it once: not after it was shown', () => {
      databaseService.setUserPreference(INTRO_OFFER_PREFERENCE, 'true');
      expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(false);
    });

    it('skips it when the configured Pane Chat agent cannot run on this platform', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'cursor')).toBe(false);
      expect(paneChatIntroOfferEligible(builtInPaneChatOnly, 'claude')).toBe(true);
    });
  });
});
