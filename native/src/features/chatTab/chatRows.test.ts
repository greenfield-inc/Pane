import { describe, expect, it } from 'vitest';

import { chatTurns } from '@shared/chatTabPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';

import { chatRows, WORKERS_FOLD } from './chatRows';

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
    const folded = chatRows(turns, { open: new Set() });
    expect(folded.map(row => row.kind)).toEqual(['user', 'fold', 'text', 'copy']);
    expect(folded[1]).toMatchObject({ summary: 'Worked for 2m 40s', open: false, running: false });
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

  it('keeps a line for a worker at work and folds the rest into one row', () => {
    const turns = chatTurns(messages, { running: false });
    const workers = [
      { paneId: 'p', name: 'csv-export', state: 'running' as const, label: 'Running' },
      ...['a', 'b'].map(paneId => ({ paneId, name: paneId, state: 'done' as const, label: 'Done' })),
    ];
    const rows = chatRows(turns, { open: new Set(), workers });
    expect(rows.slice(-2).map(row => row.key)).toEqual(['worker:p', 'workers:fold']);
    expect(rows.at(-1)).toMatchObject({ summary: '2 workers' });
    expect(chatRows(turns, { open: new Set([WORKERS_FOLD]), workers }).slice(-2).map(row => row.key)).toEqual(['worker:a', 'worker:b']);
  });
});
