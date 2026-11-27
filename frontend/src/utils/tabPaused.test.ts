import { describe, expect, it } from 'vitest';
import type { TerminalPausedMark, ToolPanel } from '../../../shared/types/panels';
import { tabShowsPaused } from './tabPaused';

const mark: TerminalPausedMark = { at: '2026-11-27T10:00:00.000Z', by: 'auto', idleHours: 1 };
// SAFETY: the check reads only the panel's type and its custom state's paused mark.
const panel = (type: ToolPanel['type'], paused?: TerminalPausedMark) => ({ type, state: { isActive: false, customState: paused ? { paused } : {} } }) as Pick<ToolPanel, 'type' | 'state'>;

describe('a tab shows its pause glyph (QA 1781 note)', () => {
  it('for a paused terminal and a paused chat, on whichever machine the window shows', () => {
    expect(tabShowsPaused(panel('terminal', mark))).toBe(true);
    expect(tabShowsPaused(panel('chat', mark))).toBe(true);
  });
  it('not for a running one, or a tab that has no agent', () => {
    expect(tabShowsPaused(panel('chat'))).toBe(false);
    expect(tabShowsPaused(panel('terminal'))).toBe(false);
    expect(tabShowsPaused(panel('browser', mark))).toBe(false);
  });
});
