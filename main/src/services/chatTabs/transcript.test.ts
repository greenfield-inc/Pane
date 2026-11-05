import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps time order when an agent message continues after a step, as Claude\'s API messages do (D-193)', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    transcript.userMessage('op-1', [{ type: 'text', text: 'Go' }]);
    transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'Before ' } });
    transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'the step.' } });
    transcript.accept({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'completed' });
    transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'After ' } });
    const later = transcript.accept({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'the step.' } });
    expect(later?.index).toBe(3);
    expect(transcript.snapshot(50).messages.map(message => message.parts[0].type === 'text' ? message.parts[0].text : message.parts[0].type)).toEqual(['Go', 'Before the step.', 'tool', 'After the step.']);
  });

  it('gives a new prompt its own to-do list, so an update never rewrites one above it (D-193)', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    const plan = (content: string) => ({ sessionUpdate: 'plan' as const, entries: [{ content, status: 'pending' as const, priority: 'high' as const }] });
    transcript.accept({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Replayed' } });
    transcript.accept(plan('first'));
    transcript.accept(plan('first, updated'));
    transcript.userMessage('op-1', [{ type: 'text', text: 'Next' }]);
    transcript.accept(plan('second'));
    const rows = transcript.snapshot(50).messages.map(message => message.role === 'user' ? 'user' : JSON.stringify(message.parts[0]).match(/"content":"([^"]+)"/)?.[1]);
    expect(rows).toEqual(['user', 'first, updated', 'user', 'second']);
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

  it('keeps a message in memory, with its index, when writing it to disk fails', () => {
    const file = spool();
    const transcript = new ChatTranscript('panel', 1, { spoolFile: file, windowMessages: 2, windowBytes: 64 * 1024 * 1024 });
    // A directory where the spool file should be: every write fails, as on a full or failing disk.
    mkdirSync(file, { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let index = 0; index < 4; index++) transcript.userMessage(`op-${index}`, [{ type: 'text', text: `question ${index}` }]);
    warn.mockRestore();
    expect(transcript.count()).toBe(4);
    expect(transcript.history(4, 4).map(message => message.parts[0].type === 'text' ? message.parts[0].text : '')).toEqual(['question 0', 'question 1', 'question 2', 'question 3']);
    expect(transcript.userMessage('op-0', [{ type: 'text', text: ' again' }])[0]?.index).toBe(0);
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

  it('streams command output as small appends into the step', () => {
    const transcript = new ChatTranscript('panel', 1, { spoolFile: spool() });
    transcript.accept({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'pnpm test', kind: 'execute', status: 'in_progress' });
    const viewer = transcript.snapshot(10);
    const first = transcript.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'x', _meta: { terminal_output_delta: 'RUN v3\n' } });
    const second = transcript.accept({ sessionUpdate: 'tool_call_update', toolCallId: 'x', _meta: { terminal_output_delta: '✓ 6 tests\n' } });
    expect(second?.change).toEqual({ type: 'tool', id: 'tool:x', patch: { terminalAppend: '✓ 6 tests\n' } });
    const followed = [first!, second!].reduce((current, event) => applyChatTabEvent(current, event).transcript, viewer);
    expect(followed.messages[0].parts[0]).toMatchObject({ terminal: 'RUN v3\n✓ 6 tests\n' });
    expect(transcript.snapshot(10).messages[0].parts[0]).toMatchObject({ terminal: 'RUN v3\n✓ 6 tests\n' });
  });
});
