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
  it('shows every step group in a worker chat', () => {
    const rows = chatRows(chatTurns(messages, { running: false }), { quiet: false, open: new Set() });
    expect(rows.map(row => row.kind)).toEqual(['user', 'steps', 'steps', 'text', 'copy']);
    // D-182: a finished response copies as the agent's text only, not its activity lines.
    const copy = rows.at(-1);
    expect(copy?.kind === 'copy' && copy.text).not.toContain('git fetch');
    expect(copy?.kind === 'copy' && copy.text).toBe(rows.flatMap(row => row.kind === 'text' ? [row.text.trim()] : []).join('\n\n'));
  });

  it('folds a finished turn to one line in the Session chat, and opens it on request', () => {
    const turns = chatTurns(messages, { running: false });
    const folded = chatRows(turns, { quiet: true, open: new Set() });
    expect(folded.map(row => row.kind)).toEqual(['user', 'fold', 'text', 'copy']);
    expect(folded[1]).toMatchObject({ summary: 'Worked 2 m 40 s · 2 steps · ran 1 command', open: false });
    const opened = chatRows(turns, { quiet: true, open: new Set([turns[0].id]) });
    expect(opened.map(row => row.kind)).toEqual(['user', 'fold', 'steps', 'steps', 'text', 'copy']);
  });

  it('shows only the current step while the Session chat works, and worker lines after their turn', () => {
    const running = chatTurns(messages.slice(0, 3), { running: true });
    const rows = chatRows(running, { quiet: true, open: new Set(), workers: [{ paneId: 'p', name: 'csv-export', state: 'running', label: 'Running' }] });
    expect(rows.map(row => row.kind)).toEqual(['user', 'current', 'worker']);
    expect(rows[1]).toMatchObject({ step: { command: 'git fetch' } });
  });
});
