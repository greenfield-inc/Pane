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

  it('asks a single-choice question and answers with the chosen value; leaves richer forms to the chat', async () => {
    const { queue, asked } = fakeQueue();
    const answers: unknown[] = [];
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: (_p, id, answer) => answers.push([id, answer]) });
    const single = { id: '1:q1', generation: 1, message: 'Which colour?', schema: { properties: { question_0: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] }, question_0_custom: { type: 'string' } } } };
    const multi = { id: '1:q2', generation: 1, message: 'Pick', schema: { properties: { a: { type: 'array', items: { anyOf: [{ const: 'x' }] } } } } };
    bridge.observe({ ...base, questions: [single, multi] });
    expect(asked.map(item => item.question.title)).toEqual(['Which colour?']);
    asked[0].answer({ answer: 'Blue' });
    await Promise.resolve(); await Promise.resolve();
    expect(answers).toEqual([['1:q1', { action: 'accept', content: { question_0: 'blue' } }]]);
  });

  it('asks nothing when Answer prompts from Pane is off', () => {
    const { queue, asked } = fakeQueue();
    const bridge = new ChatTabNotifyBridge({ queue, enabled: () => false, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: () => undefined });
    bridge.observe({ ...base, permissions: [permission] });
    expect(asked).toEqual([]);
  });
});
