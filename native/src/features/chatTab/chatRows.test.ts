import { describe, expect, it } from 'vitest';

import { chatTurns, waitingToolIds } from '@shared/chatTabPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';

import { chatRows, splitFencedBlocks } from './chatRows';

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
    const folded = chatRows(turns, { open: new Set(), now: new Date(2026, 10, 5), locale: 'en-US' });
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

  it('says a running turn waits for the person while its step has an approval pending', () => {
    const running = chatTurns([...messages.slice(0, 2), { id: 'tool:x', role: 'assistant', parts: [{ type: 'tool', id: 'x', title: 'Run', status: 'pending', kind: 'execute', input: { command: 'echo hi' } }] }], { running: true });
    const rows = chatRows(running, { open: new Set(), waiting: new Set(['x']) });
    expect(rows[1]).toMatchObject({ kind: 'fold', summary: 'Waiting for you · Running echo hi', waiting: true });
  });

  it('says a running turn waits for the person while the agent asks a question', () => {
    const running = chatTurns([...messages.slice(0, 2), { id: 'tool:q', role: 'assistant', parts: [{ type: 'tool', id: 'q', title: 'AskUserQuestion', status: 'pending', kind: 'other' }] }], { running: true });
    const waiting = waitingToolIds([], [{ id: 'question-1', generation: 1, message: 'Which colour?', schema: {}, toolCallId: 'q' }]);
    const rows = chatRows(running, { open: new Set(), waiting });
    expect(rows[1]).toMatchObject({ kind: 'fold', waiting: true });
    expect(rows[1].kind === 'fold' && rows[1].summary).toMatch(/^Waiting for you · /);
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

  it('draws registered fenced blocks itself and shows control lines as notices (Autopilot)', () => {
    const autopilot: AgentChatMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '[Pane · Start] Read every Session.' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Pane Fixes: 4 things for you.\n\n```autopilot-items\nq14\n```\n\nTap an option to answer.' }] },
    ];
    const rows = chatRows(chatTurns(autopilot, { running: false }), {
      open: new Set(), blocks: new Set(['autopilot-items']),
      notice: text => (text.startsWith('[Pane · Start]') ? 'You pressed Start' : undefined),
    });
    // A finished response ends with its copy row (D-140).
    expect(rows.map(row => row.kind)).toEqual(['notice', 'text', 'block', 'text', 'copy']);
    expect(rows[0]).toMatchObject({ text: 'You pressed Start' });
    expect(rows[2]).toMatchObject({ language: 'autopilot-items', content: 'q14\n' });
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
  });
});

describe('streaming', () => {
  it('keeps a finished turn\'s row objects while the latest turn streams, and rebuilds them when it opens', () => {
    const next: AgentChatMessage[] = [...messages, { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Push them' }] }];
    const open = new Set<string>();
    const before = chatRows(chatTurns([...next, { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Push' }] }], { running: true }), { open });
    const turns = chatTurns([...next, { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Pushing.' }] }], { running: true });
    const after = chatRows(turns, { open });
    // The finished turn's rows: its message, fold, reply and copy row.
    expect(after.slice(0, 4).map(row => row.kind)).toEqual(['user', 'fold', 'text', 'copy']);
    after.slice(0, 4).forEach((row, index) => expect(row).toBe(before[index]));
    expect(after.find(row => row.key === 'a2:0')).toMatchObject({ kind: 'text', text: 'Pushing.' });
    const opened = chatRows(turns, { open: new Set([turns[0].id]) });
    expect(opened[1]).toMatchObject({ kind: 'fold', open: true });
  });
});

describe('hidden lines', () => {
  it('drops a person\'s line whose notice is empty (Pane\'s own wake-ups)', () => {
    const messages: AgentChatMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '[Pane · Sentinel check]' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Checked in: nothing new.' }] },
    ];
    const rows = chatRows(chatTurns(messages, { running: false }), { open: new Set(), notice: text => (text.startsWith('[Pane · Sentinel check]') ? '' : undefined) });
    expect(rows.map(row => row.kind)).toEqual(['text', 'copy']);
  });
});

describe('splitFencedBlocks', () => {
  it('keeps other fences and plain text as they are', () => {
    const text = 'Run this:\n```sh\npnpm test\n```';
    expect(splitFencedBlocks(text, new Set(['autopilot-items']))).toEqual([{ kind: 'text', text }]);
    expect(splitFencedBlocks('no blocks', new Set())).toEqual([{ kind: 'text', text: 'no blocks' }]);
  });

  it('splits around each registered block, in order', () => {
    expect(splitFencedBlocks('```autopilot-items\na\n```\nthen\n```autopilot-items\nb\nc\n```', new Set(['autopilot-items']))).toEqual([
      { kind: 'block', language: 'autopilot-items', content: 'a\n' },
      { kind: 'text', text: 'then' },
      { kind: 'block', language: 'autopilot-items', content: 'b\nc\n' },
    ]);
  });
});

