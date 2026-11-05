import { describe, expect, it } from 'vitest';

import { chatTurns } from '@shared/chatTabPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';

import { chatRows } from './chatRows';

const messages: AgentChatMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Rebase them' }] },
  { id: 'tool:r', role: 'assistant', parts: [{ type: 'tool', id: 'r', title: 'Read', status: 'completed', kind: 'read', locations: [{ path: '/a.ts' }] }] },
  { id: 'tool:x', role: 'assistant', parts: [{ type: 'tool', id: 'x', title: 'Run', status: 'completed', kind: 'execute', input: { command: 'git fetch' } }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Three rebased cleanly.' }] },
  { id: 't1', role: 'assistant', parts: [{ type: 'content', content: { type: 'pane_turn', stopReason: 'end_turn', startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:02:40.000Z' } }] },
];

describe('phone chat rows', () => {
  it('folds a finished turn to one row and opens it on request (D-192)', () => {
    const turns = chatTurns(messages, { running: false });
    const folded = chatRows(turns, { open: new Set(), now: new Date(2026, 10, 5) });
    expect(folded.map(row => row.kind)).toEqual(['user', 'fold', 'text', 'copy']);
    // D-202: the latest turn says when it finished.
    const folded1 = folded[1];
    expect(folded1.kind === 'fold' && folded1.summary.replace(/\s/g, ' ')).toMatch(/^Worked for 2m 40s · Nov 3, \d{1,2}:\d{2} [AP]M$/);
    expect(folded1).toMatchObject({ open: false, running: false });
    const opened = chatRows(turns, { open: new Set([turns[0].id]) });
    expect(opened.map(row => row.kind)).toEqual(['user', 'fold', 'steps', 'steps', 'text', 'copy']);
    // D-182: a finished response copies as the agent's text only, not its activity lines.
    const copy = opened.at(-1);
    expect(copy?.kind === 'copy' && copy.text).toBe('Three rebased cleanly.');
  });

  it('says what a running turn is doing in one row', () => {
    const running = chatTurns([...messages.slice(0, 2), { id: 'tool:x', role: 'assistant', parts: [{ type: 'tool', id: 'x', title: 'Run', status: 'in_progress', kind: 'execute', input: { command: 'git fetch' } }] }], { running: true });
    const rows = chatRows(running, { open: new Set() });
    expect(rows.map(row => row.kind)).toEqual(['user', 'fold']);
    expect(rows[1]).toMatchObject({ summary: 'Running git fetch', running: true, expandable: true });
  });

  it('mentions only a worker the latest turn has news of (D-201)', () => {
    const turns = chatTurns(messages, { running: false });
    const workers = [
      { paneId: 'p', name: 'csv-export', state: 'running' as const, label: 'Running' },
      { paneId: 'q', name: 'switch-to-chat', state: 'waiting' as const, label: 'Waiting' },
      { paneId: 'a', name: 'approvals-global', state: 'done' as const, label: 'Done', reportedAt: '2026-11-03T10:01:00.000Z' },
      { paneId: 'b', name: 'old', state: 'done' as const, label: 'Done', reportedAt: '2026-11-03T09:00:00.000Z' },
    ];
    const rows = chatRows(turns, { open: new Set(), workers });
    expect(rows.flatMap(row => row.kind === 'worker' ? [row.note.text] : [])).toEqual(['switch-to-chat is asking you', 'approvals-global finished']);
    expect(rows.some(row => row.kind === 'fold' && row.summary.includes('worker'))).toBe(false);
  });
});
