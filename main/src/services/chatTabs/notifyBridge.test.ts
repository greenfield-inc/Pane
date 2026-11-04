import { describe, expect, it } from 'vitest';
import type { ChatTabView } from '../../../../shared/types/chatTab';
import type { NotifyQuestion, NotifyResult } from '../../../../shared/types/notify';
import { ChatTabNotifyBridge, type ChatPromptQueue } from './notifyBridge';

function fakeQueue() {
  const asked: Array<{ id: string; question: NotifyQuestion; answer: (result: NotifyResult) => void }> = [];
  const settled: Array<[string, string]> = [];
  const queue: ChatPromptQueue = {
    ask: request => new Promise(resolve => asked.push({ ...request, answer: resolve })),
    settle: (id, summary) => { settled.push([id, summary]); const entry = asked.find(item => item.id === id); entry?.answer({ unavailable: summary, next: '' }); },
  };
  return { queue, asked, settled };
}

const base: ChatTabView = { panelId: 'p1', agent: 'claude', generation: 1, status: 'blocked', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: 0 };
const permission = { id: '1:p1', generation: 1, title: 'Run', toolCall: { kind: 'execute', rawInput: { command: 'pnpm test' } }, options: [
  { optionId: 'allow', name: 'Yes', kind: 'allow_once' }, { optionId: 'always', name: 'Yes, always', kind: 'allow_always' }, { optionId: 'reject', name: 'No', kind: 'reject_once' },
] };

const colour = { id: '1:q1', generation: 1, message: 'Which colour?', schema: { properties: { question_0: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] }, question_0_custom: { type: 'string' } } } };
const settle = async () => { for (let turn = 0; turn < 4; turn++) await Promise.resolve(); };

describe('chat tab prompts in Notify', () => {
  it('asks an approval with the adapter\'s choices and applies the first answer', async () => {
    const { queue, asked } = fakeQueue();
    const answers: string[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ paneId: 'pane', panelId: 'p1', name: 'csv-export', agent: 'Claude' }), answerPermission: (_p, _r, option) => answers.push(option), answerQuestion: () => undefined });
    bridge.observe({ ...base, permissions: [permission] });
    bridge.observe({ ...base, permissions: [permission] });
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toMatchObject({ ui: 'options', title: 'Claude wants to run a command', detail: 'pnpm test', agentPrompt: { yes: 'Yes', no: 'No' } });
    expect(asked[0].question.choices?.map(choice => choice.label)).toEqual(['Yes', 'Yes, always', 'No']);
    asked[0].answer({ answer: 'Yes, always' });
    await Promise.resolve(); await Promise.resolve();
    expect(answers).toEqual(['always']);
  });

  it('closes the card when the chat answered first', () => {
    const { queue, settled } = fakeQueue();
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => { throw new Error('should not answer'); }, answerQuestion: () => undefined });
    bridge.observe({ ...base, permissions: [permission] });
    bridge.observe({ ...base, status: 'working', permissions: [] });
    expect(settled).toEqual([['chat:p1:1:p1', 'Answered in the chat']]);
  });

  it('asks a single-choice question and answers with the chosen value, or a typed answer in its own words', async () => {
    const { queue, asked } = fakeQueue();
    const answers: unknown[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: (_p, id, answer) => answers.push([id, answer]) });
    bridge.observe({ ...base, questions: [colour, { ...colour, id: '1:q9' }] });
    expect(asked.map(item => [item.id, item.question.ui, item.question.title])).toEqual([['chat:p1:1:q1', 'options', 'Which colour?'], ['chat:p1:1:q9', 'options', 'Which colour?']]);
    expect(asked[0].question.choices?.map(choice => choice.label)).toEqual(['Red', 'Blue', 'Skip question']);
    asked[0].answer({ answer: 'Blue' });
    asked[1].answer({ answer: 'Teal' });
    await settle();
    expect(answers).toEqual([['1:q1', { action: 'accept', content: { question_0: 'blue' } }], ['1:q9', { action: 'accept', content: { question_0_custom: 'Teal' } }]]);
  });

  it('asks a form\'s fields one at a time, with progress, and answers once with every field', async () => {
    const { queue, asked } = fakeQueue();
    const answers: unknown[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: (_p, id, answer) => answers.push([id, answer]) });
    const two = { id: '1:q2', generation: 1, message: 'Set up the export', schema: { properties: {
      question_0: { type: 'string', title: 'Format', oneOf: [{ const: 'csv', title: 'CSV' }, { const: 'json', title: 'JSON' }] }, question_0_custom: { type: 'string' },
      question_1: { type: 'string', title: 'Where', oneOf: [{ const: 'disk', title: 'Disk' }, { const: 's3', title: 'S3' }] }, question_1_custom: { type: 'string' },
    } } };
    bridge.observe({ ...base, questions: [two] });
    expect(asked.map(item => item.question.title)).toEqual(['Set up the export (1 of 2): Format']);
    asked[0].answer({ answer: 'JSON' });
    await settle();
    bridge.observe({ ...base, questions: [two] });
    expect(answers).toEqual([]);
    expect(asked.map(item => item.question.title)).toEqual(['Set up the export (1 of 2): Format', 'Set up the export (2 of 2): Where']);
    expect(asked[1].question.choices?.map(choice => choice.label)).toEqual(['Disk', 'S3', 'Skip question']);
    asked[1].answer({ answer: 'S3' });
    await settle();
    expect(answers).toEqual([['1:q2', { action: 'accept', content: { question_0: 'json', question_1: 's3' } }]]);
  });

  it('asks a multiple-choice field as free text naming choices', async () => {
    const { queue, asked } = fakeQueue();
    const answers: unknown[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: (_p, id, answer) => answers.push([id, answer]) });
    const multi = { id: '1:q3', generation: 1, message: 'Which checks?', schema: { properties: { checks: { type: 'array', items: { anyOf: [{ const: 'lint', title: 'Lint' }, { const: 'types', title: 'Typecheck' }, { const: 'unit', title: 'Unit tests' }] } } } } };
    bridge.observe({ ...base, questions: [multi] });
    expect(asked[0].question).toMatchObject({ ui: 'ask', title: 'Which checks?', suggestions: ['Lint', 'Typecheck', 'Unit tests', 'Skip question'] });
    asked[0].answer({ answer: 'lint, Unit tests.' });
    await settle();
    expect(answers).toEqual([['1:q3', { action: 'accept', content: { checks: ['lint', 'unit'] } }]]);
  });

  it('asks a text-only question as free text', async () => {
    const { queue, asked } = fakeQueue();
    const answers: unknown[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: (_p, id, answer) => answers.push([id, answer]) });
    const text = { id: '1:q4', generation: 1, message: 'Name the branch', schema: { properties: { name: { type: 'string' } } } };
    bridge.observe({ ...base, questions: [text] });
    expect(asked[0].question).toMatchObject({ ui: 'ask', title: 'Name the branch' });
    asked[0].answer({ answer: 'csv-export' });
    await settle();
    expect(answers).toEqual([['1:q4', { action: 'accept', content: { name: 'csv-export' } }]]);
  });

  it('closes the rest of a form when the chat answers it mid-series', async () => {
    const { queue, asked, settled } = fakeQueue();
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: () => { throw new Error('should not answer'); } });
    const form = { id: '1:q5', generation: 1, message: 'Details', schema: { properties: { a: { type: 'string', title: 'First' }, b: { type: 'string', title: 'Second' }, c: { type: 'string', title: 'Third' } } } };
    bridge.observe({ ...base, questions: [form] });
    asked[0].answer({ answer: 'one' });
    await settle();
    expect(asked).toHaveLength(2);
    bridge.observe({ ...base, status: 'working', questions: [] });
    expect(settled).toEqual([[asked[1].id, 'Answered in the chat']]);
    await settle();
    expect(asked).toHaveLength(2);
  });

  it('declines the question when the person skips it in Notify', async () => {
    const { queue, asked } = fakeQueue();
    const answers: unknown[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: (_p, id, answer) => answers.push([id, answer]) });
    const form = { id: '1:q6', generation: 1, message: 'Details', schema: { properties: { a: { type: 'string', title: 'First' }, b: { type: 'string', title: 'Second' } } } };
    bridge.observe({ ...base, questions: [colour, form] });
    asked[0].answer({ answer: 'Skip question' });
    asked[1].answer({ answer: 'one' });
    await settle();
    asked[2].answer({ answer: 'Skip question' });
    await settle();
    expect(answers).toEqual([['1:q1', { action: 'decline' }], ['1:q6', { action: 'decline' }]]);
    expect(asked).toHaveLength(3);
  });

  it('asks nothing when Answer prompts from Pane is off', () => {
    const { queue, asked } = fakeQueue();
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => false, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: () => undefined });
    bridge.observe({ ...base, permissions: [permission] });
    expect(asked).toEqual([]);
  });
});
