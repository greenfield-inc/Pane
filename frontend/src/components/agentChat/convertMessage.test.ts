import { expect, it } from 'vitest';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { toAssistantMessage } from './convertMessage';

it('keeps tool identity, reasoning and unknown ACP content in a read-only view message', () => {
  const converted = toAssistantMessage({ id: 'answer-a', role: 'assistant', parts: [
    { type: 'text', text: 'Done' }, { type: 'thought', text: 'Checking the file' },
    { type: 'tool', id: 'edit-a', title: 'Edit app.ts', status: 'completed', input: { path: 'app.ts' }, content: [{ type: 'diff', path: 'app.ts', oldText: 'before', newText: 'after' }] },
    { type: 'content', content: { sessionUpdate: 'future_extension', detail: 'Keep this' } },
  ] });
  expect(converted.id).toBe('answer-a');
  expect(converted.content).toMatchObject([
    { type: 'text', text: 'Done' }, { type: 'reasoning', text: 'Checking the file' },
    { type: 'tool-call', toolCallId: 'edit-a', toolName: 'Edit app.ts', result: { content: [{ type: 'diff', path: 'app.ts', newText: 'after' }] } },
    { type: 'data', name: 'acp', data: { sessionUpdate: 'future_extension', detail: 'Keep this' } },
  ]);
});

it('describes ordinary resource and extension content without changing provider identity', async () => {
  const { describeChatContent } = await import('../../../../shared/agentChatPresentation');
  const parts: JsonValue[] = [
    { type: 'resource_link', name: 'Report', uri: 'file:///workspace/report.md' },
    { type: 'resource', resource: { uri: 'file:///workspace/notes.md', text: 'Embedded notes' } },
    { type: 'future_content', information: 'Still readable' },
  ];
  for (const content of parts) {
    const message = { id: 'provider-message', role: 'assistant' as const, parts: [{ type: 'content' as const, content }] };
    const original = structuredClone(message);
    const converted = toAssistantMessage(message);
    expect(converted.id).toBe(message.id);
    expect(converted.content[0]).toEqual({ type: 'data', name: 'acp', data: content });
    expect(JSON.parse(describeChatContent(content).details)).toEqual(content);
    expect(message).toEqual(original);
  }
  expect(describeChatContent(parts[0])).toMatchObject({ label: 'Resource: Report', uri: 'file:///workspace/report.md' });
  expect(describeChatContent(parts[1])).toMatchObject({ text: 'Embedded notes', uri: 'file:///workspace/notes.md' });
});
