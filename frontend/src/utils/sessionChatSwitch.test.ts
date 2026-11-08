import { describe, expect, it } from 'vitest';
import type { SessionChatSwitchOutcome } from '../../../shared/types/chatTab';
import { summarizeSessionSwitch } from './sessionChatSwitch';

let next = 0;
function item(result: SessionChatSwitchOutcome['result'], kind?: 'busy' | 'plain-codex' | 'other'): SessionChatSwitchOutcome {
  const outcome: SessionChatSwitchOutcome = { panelId: `p-${++next}`, title: 't', paneName: 'p', result };
  if (kind) outcome.skip = { kind, reason: 'why' };
  return outcome;
}

describe('the summary after switching a Session to chat', () => {
  it('counts switched, skipped and failed tabs, with each skip kind once', () => {
    expect(summarizeSessionSwitch([item('switched'), item('switched'), item('switched'), item('switched'), item('skipped', 'busy')])).toBe('4 switched, 1 skipped: busy');
    expect(summarizeSessionSwitch([item('switched'), item('skipped', 'busy'), item('skipped', 'busy'), item('skipped', 'plain-codex'), item('failed', 'other')]))
      .toBe('1 switched, 3 skipped: busy, plain Codex, 1 failed');
    expect(summarizeSessionSwitch([item('failed', 'other')])).toBe('0 switched, 1 failed');
  });
});
