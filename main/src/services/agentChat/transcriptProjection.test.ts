import { describe, expect, it } from 'vitest';
import { TranscriptProjection } from './transcriptProjection';
import { applyAgentChatEvent } from '../../../../shared/types/agentChat';

describe('ACP transcript projection', () => {
  it('reconciles replayed events, detects a reconnect gap and refuses an old runtime generation', () => {
    const transcript = new TranscriptProjection('panel-a', 3);
    const baseline = transcript.snapshot();
    const first = transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'One' } });
    const second = transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: ' two' } });
    const initial = applyAgentChatEvent(baseline, first);
    expect(initial.resync).toBe(false);
    const replayed = applyAgentChatEvent(initial.transcript, first);
    expect(replayed.transcript.messages[0].parts).toEqual([{ type: 'text', text: 'One' }]);
    expect(applyAgentChatEvent(baseline, second).resync).toBe(true);
    expect(applyAgentChatEvent(initial.transcript, { ...second, generation: 2 }).transcript).toEqual(initial.transcript);
    const complete = applyAgentChatEvent(initial.transcript, second);
    expect(complete.transcript).toEqual(transcript.snapshot());
  });

  it('streams text and updates one tool card without losing its earlier title or input', () => {
    const transcript = new TranscriptProjection('panel-a', 3);
    transcript.accept({ sessionUpdate: 'user_message_chunk', messageId: 'user-a', content: { type: 'text', text: 'Change it' } });
    transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'answer-a', content: { type: 'text', text: 'I will ' } });
    transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'answer-a', content: { type: 'text', text: 'edit it.' } });
    transcript.accept({ sessionUpdate: 'tool_call', toolCallId: 'tool-a', title: 'Edit app.ts', status: 'in_progress', rawInput: { path: 'app.ts' } });
    transcript.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-a', status: 'completed', content: [{ type: 'diff', path: 'app.ts', oldText: 'before', newText: 'after' }] });
    expect(transcript.snapshot().messages).toEqual([
      { id: 'user-a', role: 'user', parts: [{ type: 'text', text: 'Change it' }] },
      { id: 'answer-a', role: 'assistant', parts: [{ type: 'text', text: 'I will edit it.' }] },
      { id: 'tool:tool-a', role: 'assistant', parts: [{ type: 'tool', id: 'tool-a', title: 'Edit app.ts', status: 'completed', input: { path: 'app.ts' }, content: [{ type: 'diff', path: 'app.ts', oldText: 'before', newText: 'after' }] }] },
    ]);
  });
});

it('bounds the display cache and reports an oversized history without pretending it loaded fully', () => {
  const projection = new TranscriptProjection('panel-a', 1, { maxBytes: 64, maxMessages: 2 });
  projection.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a'.repeat(100) } });
  expect(() => projection.assertComplete()).toThrow(/display limit/i);
  expect(projection.snapshot().messages).toHaveLength(0);
});
