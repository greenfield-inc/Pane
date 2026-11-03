import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyChatTabEvent, type ChatTabEvent } from '../../../../shared/types/chatTab';
import { ChatTranscript } from './transcript';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function spool(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-transcript-'));
  directories.push(directory);
  return path.join(directory, 'transcript.jsonl');
}

describe('chat tab transcript', () => {
  it('joins streamed chunks into one reply and gives viewers the same result from events', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    const viewer = transcript.snapshot(50);
    const events: ChatTabEvent[] = [];
    for (const text of ['Hel', 'lo ', 'there']) {
      const event = transcript.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      if (event) events.push(event);
    }
    expect(transcript.snapshot(50).messages).toEqual([{ id: expect.any(String), role: 'assistant', parts: [{ type: 'text', text: 'Hello there' }] }]);
    const applied = events.reduce((current, event) => applyChatTabEvent(current, event).transcript, viewer);
    expect(applied).toEqual(transcript.snapshot(50));
  });

  it('sends only the changed fields of a tool step', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    transcript.accept({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests', kind: 'execute', status: 'in_progress', rawInput: { command: 'pnpm test' } });
    const viewer = transcript.snapshot(50);
    const update = transcript.accept({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(update?.change).toEqual({ type: 'tool', id: 'tool:t1', patch: { status: 'completed' } });
    expect(applyChatTabEvent(viewer, update!).transcript.messages[0].parts[0]).toEqual({ type: 'tool', id: 't1', title: 'Run tests', kind: 'execute', status: 'completed', input: { command: 'pnpm test' } });
  });

  it('shows the user\'s message once when the agent echoes it', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    transcript.userMessage('op-1', [{ type: 'text', text: 'Fix the bug' }]);
    expect(transcript.accept({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the bug' } })).toBeUndefined();
    transcript.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'On it.' } });
    expect(transcript.snapshot(50).messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('keeps an unknown update as a plain row', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    // An update this Pane version has never seen, as it arrives off the wire.
    transcript.accept(JSON.parse('{"sessionUpdate":"future_thing","detail":"x"}'));
    expect(transcript.snapshot(50).messages[0].parts[0]).toEqual({ type: 'content', content: { sessionUpdate: 'future_thing', detail: 'x' } });
  });

  it('never stops a long conversation, keeps a bounded window in memory and pages older messages from disk', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool(), windowMessages: 500, windowBytes: 64 * 1024 * 1024 });
    for (let index = 0; index < 6000; index++) {
      transcript.userMessage(`op-${index}`, [{ type: 'text', text: `question ${index}` }]);
      transcript.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${index} ${'x'.repeat(200)}` } });
      transcript.endTurn();
    }
    expect(transcript.count()).toBe(12000);
    expect(transcript.resident()).toBeLessThanOrEqual(500);
    const latest = transcript.snapshot(100);
    expect(latest.start).toBe(11900);
    expect(latest.messages[0].parts[0]).toEqual({ type: 'text', text: 'question 5950' });
    const older = transcript.history(2, 4);
    expect(older.map(message => message.parts[0].type === 'text' ? message.parts[0].text.slice(0, 10) : '')).toEqual(['question 0', 'answer 0 x']);
    expect(transcript.history(11000, 2).map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('replays the largest session seen (6,000 messages, 45 MB) inside a bounded memory window', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    const reply = 'y'.repeat(7_500);
    const started = Date.now();
    for (let index = 0; index < 3000; index++) {
      transcript.accept({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `question ${index}` } });
      transcript.accept({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
    }
    expect(transcript.count()).toBe(6000);
    // Under the 64 MB per-tab budget (J16), counting text as UTF-16 in memory.
    expect(transcript.residentSize()).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(transcript.history(10, 2)).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
