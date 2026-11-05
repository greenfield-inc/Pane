import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import { chatTurns, currentActivity, foldWorkers, planEntryKeys, stoppedText, turnDisplay, turnSummary, type ChatTurn, type ChatWorkerLine } from '../../../../shared/chatTabPresentation';

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
    expect(turnSummary(first)).toBe('Worked for 2m 40s');
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
    expect(turnSummary(turn)).toBe('Running pnpm test');
  });

  it('says how a turn stopped when it did not end normally', () => {
    const [turn] = chatTurns([user('u1', 'go'), say('a', 'partial'), end('t', 5, 'cancelled')], { running: false });
    expect(turn.stopReason).toBe('cancelled');
    // How it stopped is said once, in the line under the turn.
    expect(turnSummary(turn)).toBe('Worked for 5s');
    expect(stoppedText(turn)).toBe('Stopped.');
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

describe('worker lines in the Session chat', () => {
  it('reads state, PR and one line of detail from Pane\'s own Session state', async () => {
    const { workerLines } = await import('../../../../shared/chatTabPresentation');
    const lines = workerLines([
      { paneId: 'a', name: 'cmd-f-find', missing: false, archived: false, panels: [{ state: 'idle' }], report: { state: 'done', pr: 1230, summary: 'PR #1230 ready\nmore' } },
      { paneId: 'b', name: 'csv-export', missing: false, archived: false, panels: [{ state: 'working' }] },
      { paneId: 'c', name: 'notify-sound', missing: false, archived: false, panels: [{ state: 'blocked' }], report: { state: 'blocked', question: 'Which sound?' } },
      { paneId: 'd', name: 'old', missing: false, archived: true, panels: [] },
    ], new Map([['b', '2026-11-03T11:42:00.000Z']]));
    expect(lines).toEqual([
      { paneId: 'a', name: 'cmd-f-find', state: 'done', label: 'Done', detail: 'PR #1230 ready', pr: 1230 },
      { paneId: 'b', name: 'csv-export', state: 'running', label: 'Running', attachedAt: '2026-11-03T11:42:00.000Z' },
      { paneId: 'c', name: 'notify-sound', state: 'waiting', label: 'Waiting', detail: 'Which sound?' },
    ]);
  });

  it('keeps a line for workers running, blocked or changed in the latest turn, and folds the rest (D-192)', () => {
    const turns: ChatTurn[] = [
      { id: 't1', items: [], running: false, startedAt: '2026-11-03T11:40:00.000Z', endedAt: '2026-11-03T11:41:00.000Z' },
      { id: 't2', items: [], running: false, startedAt: '2026-11-03T11:50:00.000Z', endedAt: '2026-11-03T11:51:00.000Z' },
    ];
    const worker = (paneId: string, state: ChatWorkerLine['state'], reportedAt?: string): ChatWorkerLine => ({ paneId, name: paneId, state, label: state, reportedAt });
    const workers = [worker('running', 'running'), worker('blocked', 'waiting'), worker('just-done', 'done', '2026-11-03T11:50:30.000Z'), worker('old-done', 'done', '2026-11-03T11:00:00.000Z'), worker('idle', 'idle')];
    const fold = foldWorkers(turns, workers);
    expect(fold.shown.map(line => line.paneId)).toEqual(['running', 'blocked', 'just-done']);
    expect(fold.rest.map(line => line.paneId)).toEqual(['old-done', 'idle']);
    // A running turn has no start of its own yet: it began when the one before it ended.
    const running = foldWorkers([turns[0], { id: 't2', items: [], running: true }], [worker('since', 'done', '2026-11-03T11:45:00.000Z'), worker('before', 'done', '2026-11-03T11:30:00.000Z')]);
    expect(running.shown.map(line => line.paneId)).toEqual(['since']);
  });
});

describe('what a turn shows by default (D-192)', () => {
  const thought = (id: string, text: string): AgentChatMessage => ({ id, role: 'assistant', parts: [{ type: 'thought', text }] });

  it('shows only text and folds steps, thinking, notices and to-do lists at the first of them', () => {
    const [turn] = chatTurns([
      user('u', 'go'), say('a1', 'Looking.'), thought('th', 'Hmm'), tool('r', 'read'),
      { id: 'plan:1', role: 'assistant', parts: [{ type: 'content', content: { type: 'plan', entries: [{ content: 'x', status: 'pending' }] } }] },
      { id: 'n', role: 'assistant', parts: [{ type: 'content', content: { sessionUpdate: 'notice', text: 'A background command finished' } }] },
      say('a2', 'Done.'), end('t', 27),
    ], { running: false });
    const display = turnDisplay(turn);
    expect(display.shown.map(item => item.type === 'text' && item.text)).toEqual(['Looking.', 'Done.']);
    expect(display.activity.map(item => item.type)).toEqual(['thought', 'steps', 'plan', 'content']);
    expect(display.foldAt).toBe(1);
    expect(turnSummary(turn)).toBe('Worked for 27s');
  });

  it('puts the live row under the text so far and says what is happening', () => {
    const working = (...rest: AgentChatMessage[]) => chatTurns([user('u', 'go'), ...rest], { running: true })[0];
    expect(currentActivity(working(say('a', 'Hi')))).toBe('Working');
    expect(currentActivity(working(thought('t', 'Hmm')))).toBe('Thinking');
    expect(currentActivity(working(tool('r', 'read', { status: 'in_progress', locations: [{ path: '/repo/a.ts' }] })))).toBe('Reading a.ts');
    expect(currentActivity(working(tool('e', 'edit', { status: 'in_progress', locations: [{ path: '/repo/a.ts' }] })), new Set(['e']))).toBe('Waiting for you · Editing a.ts');
    expect(currentActivity(working(tool('x', 'execute', { status: 'in_progress', input: { command: 'pnpm test\n--all' } })))).toBe('Running pnpm test');
    const turn = working(tool('r', 'read'), say('a', 'Hi'));
    expect(turnDisplay(turn).foldAt).toBe(1);
  });
});

describe('time order (D-193)', () => {
  it('starts a turn of its own for what the agent does after a turn ended, before the next message', () => {
    const turns = chatTurns([
      user('u1', 'one'), tool('a', 'read'), end('t1', 5),
      tool('b', 'read'), say('own', 'A background command finished.'), end('t2', 2),
      user('u2', 'two'), tool('c', 'read'), end('t3', 1),
    ], { running: false });
    expect(turns.map(turn => turn.user?.id)).toEqual(['u1', undefined, 'u2']);
    expect(turns.map(turn => turn.items.flatMap(item => item.type === 'steps' ? item.groups.flatMap(group => group.steps.map(step => step.id)) : []))).toEqual([['a'], ['b'], ['c']]);
    expect(turns.map(turn => turnSummary(turn))).toEqual(['Worked for 5s', 'Worked for 2s', 'Worked for 1s']);
  });

  it('marks the agent\'s own turn as running while it works', () => {
    const turns = chatTurns([user('u1', 'one'), end('t1', 5), tool('b', 'read', { status: 'in_progress' })], { running: true });
    expect(turns.map(turn => turn.running)).toEqual([false, true]);
  });

  it('never rewrites a finished turn\'s time with a later marker', () => {
    const [turn] = chatTurns([user('u1', 'one'), end('t1', 5), end('t2', 50)], { running: false });
    expect(turnSummary(turn)).toBe('Worked for 5s');
  });
});

describe('planEntryKeys', () => {
  it('keys plan rows by their text and numbers repeats, so a row keeps its key as the list grows', () => {
    expect(planEntryKeys([{ content: 'Read the code', status: 'completed' }, { content: 'Run tests', status: 'pending' }, { content: 'Run tests', status: 'pending' }]))
      .toEqual(['Read the code', 'Run tests', 'Run tests#2']);
  });
});
