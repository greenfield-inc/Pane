import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import { chatTurns, turnSummary } from '../../../../shared/chatTabPresentation';

const user = (id: string, text: string): AgentChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const say = (id: string, text: string): AgentChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const tool = (id: string, kind: string, extra: Partial<Extract<AgentChatMessage['parts'][number], { type: 'tool' }>> = {}): AgentChatMessage => ({ id: `tool:${id}`, role: 'assistant', parts: [{ type: 'tool', id, title: `${kind} ${id}`, status: 'completed', kind, ...extra }] });
const end = (id: string, seconds: number, stopReason = 'end_turn'): AgentChatMessage => ({ id, role: 'assistant', parts: [{ type: 'content', content: { type: 'pane_turn', stopReason, startedAt: '2026-11-03T10:00:00.000Z', endedAt: new Date(Date.parse('2026-11-03T10:00:00.000Z') + seconds * 1000).toISOString() } }] });

describe('chat turns', () => {
  it('starts a turn at each user message and groups consecutive steps between replies', () => {
    const turns = chatTurns([
      user('u1', 'Fix it'),
      say('a1', 'Looking.'),
      tool('r1', 'read', { locations: [{ path: '/repo/a.ts' }] }),
      tool('r2', 'read', { locations: [{ path: '/repo/b.ts' }] }),
      tool('s1', 'search'),
      tool('e1', 'edit', { content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'one\ntwo\n', newText: 'one\n2\nthree\n' }] }),
      say('a2', 'Done.'),
      end('t1', 160),
      user('u2', 'Thanks'),
    ], { running: false });
    expect(turns).toHaveLength(2);
    const [first] = turns;
    expect(first.user?.id).toBe('u1');
    expect(first.items.map(item => item.type)).toEqual(['text', 'steps', 'text']);
    const steps = first.items[1];
    expect(steps.type === 'steps' && steps.groups.map(group => ({ kind: group.kind, label: group.label }))).toEqual([
      { kind: 'explore', label: '2 files, 1 search' },
      { kind: 'edit', label: 'a.ts' },
    ]);
    expect(steps.type === 'steps' && steps.groups[1].steps[0]).toMatchObject({ path: '/repo/a.ts', added: 2, removed: 1 });
    expect(turnSummary(first)).toBe('Worked 2 m 40 s · 4 steps · edited 1 file');
    expect(first.running).toBe(false);
    expect(turns[1].running).toBe(false);
  });

  it('lists commands in one group and counts them, and marks the last turn running', () => {
    const turns = chatTurns([
      user('u1', 'Test'),
      tool('x1', 'execute', { input: { command: 'pnpm test' }, output: { stdout: 'ok' } }),
      tool('x2', 'execute', { input: { command: 'git fetch' } }),
      tool('x3', 'execute', { input: { command: 'pnpm test' }, status: 'in_progress' }),
    ], { running: true });
    const [turn] = turns;
    expect(turn.running).toBe(true);
    const steps = turn.items[0];
    expect(steps.type === 'steps' && steps.groups[0]).toMatchObject({ kind: 'run', label: '3 commands', detail: 'pnpm test ×2, git fetch' });
    expect(turn.current?.command).toBe('pnpm test');
    expect(turnSummary(turn)).toBe('Working · 3 steps · ran 3 commands');
  });

  it('says how a turn stopped when it did not end normally', () => {
    const [turn] = chatTurns([user('u1', 'go'), say('a', 'partial'), end('t', 5, 'cancelled')], { running: false });
    expect(turn.stopReason).toBe('cancelled');
    expect(turnSummary(turn)).toBe('Stopped after 5 s');
  });

  it('keeps a todo list and unknown content as their own items', () => {
    const [turn] = chatTurns([
      user('u1', 'plan'),
      { id: 'plan:1', role: 'assistant', parts: [{ type: 'content', content: { type: 'plan', entries: [{ content: 'Read', status: 'completed', priority: 'high' }] } }] },
      { id: 'x', role: 'assistant', parts: [{ type: 'content', content: { sessionUpdate: 'future' } }] },
    ], { running: false });
    expect(turn.items.map(item => item.type)).toEqual(['plan', 'content']);
    expect(turn.items[0].type === 'plan' && turn.items[0].entries).toEqual([{ content: 'Read', status: 'completed', priority: 'high' }]);
  });
});

describe('approval summaries', () => {
  const options = [{ optionId: 'a', name: 'Yes', kind: 'allow_once' }, { optionId: 'r', name: 'No', kind: 'reject_once' }];
  it('names a command, a file change and a plan', async () => {
    const { permissionSummary, rejectOption } = await import('../../../../shared/chatTabPermissions');
    expect(permissionSummary({ id: '1', generation: 1, title: 'Bash', toolCall: { kind: 'execute', rawInput: { command: 'pnpm test --filter payments' } }, options }, 'Claude'))
      .toEqual({ kind: 'command', heading: 'Claude wants to run a command', detail: 'pnpm test --filter payments' });
    expect(permissionSummary({ id: '2', generation: 1, title: 'Edit', toolCall: { kind: 'edit', rawInput: { file_path: '/repo/a.ts' } }, options }, 'Claude').detail).toBe('/repo/a.ts');
    expect(permissionSummary({ id: '3', generation: 1, title: 'Ready to code?', toolCall: { title: 'Ready to code?', rawInput: { plan: '1. Do it' } }, options }, 'Claude'))
      .toEqual({ kind: 'plan', heading: "Claude's plan is ready", plan: '1. Do it' });
    expect(rejectOption({ id: '1', generation: 1, title: '', toolCall: {}, options })).toBe('r');
  });
});
