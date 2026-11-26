import { describe, expect, it } from 'vitest';
import type { AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { readRecords } from './agentMessagesContext';

const record = (number: number, createdAt: string): AgentMessageRecord => ({
  ref: `M-${number}`, number, kind: 'message', replyTo: null, text: 'x', state: 'delivered', deliveredVia: null, undeliveredReason: null, replies: [],
  sender: { panelId: 'a', paneId: null, sessionId: null, name: 'A', orchestrator: false },
  receiver: { panelId: 'b', paneId: null, sessionId: null, name: 'B', orchestrator: false },
  createdAt, deliveredAt: null, answeredAt: null,
});

/** 450 messages, one a minute from 10:00, served newest first in pages of 200 as forPanel does. */
const all = Array.from({ length: 450 }, (_, index) => record(index + 1, new Date(Date.UTC(2026, 10, 25, 10, index)).toISOString())).reverse();
function fakeForPanel(calls: Array<string | undefined>) {
  return async (_panelId: string, page?: { before?: string | number }) => {
    calls.push(page?.before === undefined ? undefined : String(page.before));
    const before = page?.before === undefined ? Infinity : Number(String(page.before).replace('M-', ''));
    return { success: true, data: all.filter(item => item.number < before).slice(0, 200) };
  };
}

describe('readRecords', () => {
  it('reads one page when the newest page already reaches the oldest turn', async () => {
    const calls: Array<string | undefined> = [];
    const records = await readRecords(fakeForPanel(calls), 'b', Date.UTC(2026, 10, 25, 16, 0));
    expect(calls).toEqual([undefined]);
    expect(records).toHaveLength(200);
  });

  it('pages back until it covers the oldest turn, then stops', async () => {
    const calls: Array<string | undefined> = [];
    const records = await readRecords(fakeForPanel(calls), 'b', Date.UTC(2026, 10, 25, 12, 0));
    expect(calls).toEqual([undefined, 'M-251']);
    expect(records?.at(-1)?.ref).toBe('M-51');
  });

  it('stops at the last page', async () => {
    const calls: Array<string | undefined> = [];
    const records = await readRecords(fakeForPanel(calls), 'b', Date.UTC(2026, 10, 25, 9, 0));
    expect(calls).toEqual([undefined, 'M-251', 'M-51']);
    expect(records).toHaveLength(450);
  });
});
