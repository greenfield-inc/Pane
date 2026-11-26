import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectDirName, parseClaudeLine } from './claude';
import { CLAUDE_API_ENOTFOUND_TRANSCRIPT_LINE } from '../agentStatus/__fixtures__/claudeApiErrorScreens';
import { agentTranscripts, turnTextMatches, type TranscriptCursor, type TranscriptLocator } from './index';

const { findUserTurnSince, lastAssistantMessage, readFinishedTurns } = agentTranscripts;
import { readTranscriptTail } from './tail';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';

// Line shapes recorded from Claude Code 2.1.283 and Codex 0.157.1 (see the
// PR5b spike); only the fields the reader relies on are kept.
const claude = {
  user: (text: string, timestamp: string, extra: JsonObject = {}) => ({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp,
    origin: { kind: 'human' },
    promptSource: 'typed',
    ...extra,
  }),
  enqueue: (content: string, timestamp: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp, content }),
  dequeue: (timestamp: string) => ({ type: 'queue-operation', operation: 'dequeue', timestamp }),
  assistant: (id: string, block: JsonObject, timestamp: string) => ({
    type: 'assistant',
    message: { id, role: 'assistant', content: [block] },
    timestamp,
  }),
};

const codex = {
  meta: (cwd: string, timestamp: string) => ({
    timestamp,
    type: 'session_meta',
    payload: { id: 'thread', timestamp, cwd, originator: 'codex-tui', base_instructions: { text: 'x'.repeat(2_000) } },
  }),
  user: (text: string, timestamp: string) => ({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }),
  assistant: (text: string, timestamp: string) => ({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  }),
};

// Fixture files are dated just after their entries, whatever the test machine's clock says.
const writtenAt = new Date('2026-09-27T19:00:00.000Z');
const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

let home: string;
let worktree: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-transcript-home-')));
  worktree = path.join(home, 'repo-worktrees', 'task.one');
  fs.mkdirSync(worktree, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('CODEX_HOME', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeClaude(sessionId: string, rows: object[]): string {
  const dir = path.join(home, '.claude', 'projects', claudeProjectDirName(worktree));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, jsonl(rows));
  fs.utimesSync(file, writtenAt, writtenAt);
  return file;
}

function writeCodex(name: string, rows: object[]): string {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '27');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-27T11-37-14-${name}.jsonl`);
  fs.writeFileSync(file, jsonl(rows));
  fs.utimesSync(file, writtenAt, writtenAt);
  return file;
}

const sentAt = Date.parse('2026-09-27T18:34:10.000Z');
const claudeLocator = (): TranscriptLocator => ({ agent: 'claude', cwd: worktree, sessionId: '11111111-2222-4333-8444-555555555504' });
const codexLocator = (): TranscriptLocator => ({ agent: 'codex', cwd: worktree });

it.each(['claude', 'codex'] as const)('reads %s transcripts from the configured agent home', async agent => {
  const locator = agent === 'claude' ? claudeLocator() : codexLocator();
  if (agent === 'claude') {
    writeClaude(locator.sessionId!, [claude.assistant('reply', { type: 'text', text: 'Custom home reply' }, writtenAt.toISOString())]);
  } else {
    writeCodex('thread', [codex.meta(worktree, writtenAt.toISOString()), codex.assistant('Custom home reply', writtenAt.toISOString())]);
  }
  const customHome = path.join(home, 'custom-agent');
  fs.renameSync(path.join(home, agent === 'claude' ? '.claude' : '.codex'), customHome);
  vi.stubEnv(agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', customHome);
  expect(await lastAssistantMessage(locator, 1000)).toBe('Custom home reply');
});

describe('turnTextMatches', () => {
  it('compares text loosely: CRLF, whitespace runs and Claude paste wrappers', () => {
    expect(turnTextMatches('Reply with OK', 'Reply with OK\n')).toBe(true);
    expect(turnTextMatches('line one\nline  two', 'line one\r\nline two')).toBe(true);
    expect(turnTextMatches('\n\n<pasted_content id="922c">\nLine 1\nLine 2\n</pasted_content id="922c">\n', 'Line 1\nLine 2')).toBe(true);
    expect(turnTextMatches('Read and follow /tmp/prompts/p.md', 'Read and follow /tmp/prompts/p.md')).toBe(true);
    expect(turnTextMatches('Reply with OK', 'Reply with NO')).toBe(false);
  });

  it('only accepts a containing turn for text long enough to be distinctive', () => {
    expect(turnTextMatches('please say yes now', 'yes')).toBe(false);
    expect(turnTextMatches('[Image #1] Read and follow the attached brief for this task', 'Read and follow the attached brief for this task')).toBe(true);
  });

  it('matches long text by its start, end and length', () => {
    const sent = Array.from({ length: 60 }, (_, index) => `Line ${index} of a long prompt.`).join('\n');
    const recorded = sent.replace('Line 30 of', 'Line 30 0f');
    expect(turnTextMatches(recorded, sent)).toBe(true);
    expect(turnTextMatches(`${sent}\n${sent}`, 'x'.repeat(10) + sent.slice(10))).toBe(false);
  });
});

describe('findUserTurnSince (Claude)', () => {
  it('reports a taken turn', async () => {
    const file = writeClaude('11111111-2222-4333-8444-555555555504', [
      claude.user('Earlier prompt', '2026-09-27T18:30:00.000Z'),
      claude.user('Reply with the single word OK', '2026-09-27T18:34:11.941Z'),
      claude.assistant('msg_1', { type: 'text', text: 'OK' }, '2026-09-27T18:34:12.950Z'),
    ]);

    await expect(findUserTurnSince(claudeLocator(), sentAt, 'Reply with the single word OK\n')).resolves.toEqual({
      state: 'taken',
      file,
      timestamp: '2026-09-27T18:34:11.941Z',
    });
  });

  it('reports a message queued while Claude works, then taken once dequeued', async () => {
    const file = writeClaude('11111111-2222-4333-8444-555555555504', [
      claude.user('Write the numbers from 1 to 400', '2026-09-27T18:34:11.941Z'),
      claude.enqueue('Reply with the single word QUEUED', '2026-09-27T18:34:17.129Z'),
    ]);

    await expect(findUserTurnSince(claudeLocator(), Date.parse('2026-09-27T18:34:16.000Z'), 'Reply with the single word QUEUED'))
      .resolves.toMatchObject({ state: 'queued', file });

    fs.appendFileSync(file, jsonl([
      claude.dequeue('2026-09-27T18:34:17.980Z'),
      claude.user('Reply with the single word QUEUED', '2026-09-27T18:34:17.985Z'),
    ]));
    fs.utimesSync(file, writtenAt, writtenAt);
    await expect(findUserTurnSince(claudeLocator(), Date.parse('2026-09-27T18:34:16.000Z'), 'Reply with the single word QUEUED'))
      .resolves.toMatchObject({ state: 'taken', timestamp: '2026-09-27T18:34:17.985Z' });
  });

  it('ignores turns before the send, other text, and background-task notifications', async () => {
    const file = writeClaude('11111111-2222-4333-8444-555555555504', [
      claude.user('Reply with the single word OK', '2026-09-27T18:30:00.000Z'),
      claude.user('Something else', '2026-09-27T18:34:11.000Z'),
      claude.enqueue('<task-notification>\n<task-id>b8</task-id>', '2026-09-27T18:34:12.000Z'),
      claude.user('<task-notification>done</task-notification>', '2026-09-27T18:34:13.000Z', { origin: { kind: 'task-notification' } }),
    ]);

    await expect(findUserTurnSince(claudeLocator(), sentAt, 'Reply with the single word OK')).resolves.toEqual({ state: null, file });
    // Without text, any typed turn since the send counts, but not the notifications.
    await expect(findUserTurnSince(claudeLocator(), Date.parse('2026-09-27T18:34:11.500Z'), undefined)).resolves.toEqual({ state: null, file });
    await expect(findUserTurnSince(claudeLocator(), sentAt, undefined)).resolves.toMatchObject({ state: 'taken' });
  });

  it('matches a paste Claude recorded inside its pasted_content wrapper', async () => {
    const pasted = Array.from({ length: 14 }, (_, index) => `Line ${index + 1} of a pasted prompt.`).join('\n');
    writeClaude('11111111-2222-4333-8444-555555555504', [
      claude.user(`\n\n<pasted_content id="922c">\n${pasted}\n</pasted_content id="922c">\n`, '2026-09-27T18:34:19.046Z'),
    ]);

    await expect(findUserTurnSince(claudeLocator(), sentAt, pasted)).resolves.toMatchObject({ state: 'taken' });
  });

  it('reports no transcript when the session has none', async () => {
    await expect(findUserTurnSince(claudeLocator(), sentAt, 'anything')).resolves.toEqual({ state: null });
  });

  it('finds the working directory\'s recent transcripts when Pane does not know the session id', async () => {
    writeClaude('0e1f', [claude.user('Reply with the single word OK', '2026-09-27T18:34:11.941Z')]);

    await expect(findUserTurnSince({ agent: 'claude', cwd: worktree }, sentAt, 'Reply with the single word OK'))
      .resolves.toMatchObject({ state: 'taken' });
    await expect(findUserTurnSince({ agent: 'claude', cwd: worktree }, Date.parse('2026-09-27T19:30:00.000Z'), 'Reply with the single word OK'))
      .resolves.toEqual({ state: null });
  });
});

describe('findUserTurnSince (Codex)', () => {
  it('finds the rollout for the worktree and reports a taken turn', async () => {
    writeCodex('other', [codex.meta('/somewhere/else', '2026-09-27T18:37:14.814Z'), codex.user('Reply with OK', '2026-09-27T18:37:22.184Z')]);
    const file = writeCodex('01a0e428', [
      codex.meta(worktree, '2026-09-27T18:37:14.814Z'),
      codex.user('# AGENTS.md instructions\n\n<INSTRUCTIONS>', '2026-09-27T18:37:22.121Z'),
      codex.user('Reply with OK', '2026-09-27T18:37:22.184Z'),
      codex.assistant('OK', '2026-09-27T18:37:23.486Z'),
    ]);

    await expect(findUserTurnSince(codexLocator(), Date.parse('2026-09-27T18:37:20.000Z'), 'Reply with OK'))
      .resolves.toMatchObject({ state: 'taken', file });
  });

  it('finds no turn for a message Codex still holds (Codex writes it only once taken)', async () => {
    const file = writeCodex('01a0e428', [
      codex.meta(worktree, '2026-09-27T18:37:14.814Z'),
      codex.user('Write the numbers from 1 to 400', '2026-09-27T18:37:35.014Z'),
    ]);

    await expect(findUserTurnSince(codexLocator(), Date.parse('2026-09-27T18:37:40.000Z'), 'Reply with the single word QUEUED'))
      .resolves.toEqual({ state: null, file });
    await expect(findUserTurnSince(codexLocator(), Date.parse('2026-09-27T18:37:40.000Z'), undefined))
      .resolves.toEqual({ state: null, file });
  });

  it('finds a known thread by its rollout name', async () => {
    const file = writeCodex('01a0e428-3298-7d23-841d-bb5000a859d0', [
      codex.meta('/moved/worktree', '2026-09-27T18:37:14.814Z'),
      codex.user('Reply with OK', '2026-09-27T18:37:22.184Z'),
    ]);

    await expect(findUserTurnSince(
      { agent: 'codex', cwd: worktree, sessionId: '01a0e428-3298-7d23-841d-bb5000a859d0' },
      Date.parse('2026-09-27T18:37:20.000Z'),
      'Reply with OK',
    )).resolves.toMatchObject({ state: 'taken', file });
  });
});

describe('lastAssistantMessage', () => {
  it('joins the text blocks of Claude\'s last message and skips thinking and tool calls', async () => {
    writeClaude('11111111-2222-4333-8444-555555555504', [
      claude.user('Do it', '2026-09-27T18:34:11.941Z'),
      claude.assistant('msg_1', { type: 'text', text: 'First reply' }, '2026-09-27T18:34:12.000Z'),
      claude.assistant('msg_2', { type: 'thinking', thinking: '...' }, '2026-09-27T18:34:13.000Z'),
      claude.assistant('msg_2', { type: 'text', text: 'Done: opened PR 12.' }, '2026-09-27T18:34:14.000Z'),
      claude.assistant('msg_2', { type: 'text', text: 'Tests pass.' }, '2026-09-27T18:34:14.100Z'),
      claude.assistant('msg_3', { type: 'tool_use', name: 'Bash', input: {} }, '2026-09-27T18:34:15.000Z'),
    ]);

    await expect(lastAssistantMessage(claudeLocator())).resolves.toBe('Done: opened PR 12.\nTests pass.');
  });

  it('reads Codex\'s last reply, and nothing without a transcript', async () => {
    writeCodex('01a0e428', [
      codex.meta(worktree, '2026-09-27T18:37:14.814Z'),
      codex.assistant('OK', '2026-09-27T18:37:23.486Z'),
      codex.assistant('QUEUED', '2026-09-27T18:38:03.514Z'),
    ]);

    await expect(lastAssistantMessage(codexLocator())).resolves.toBe('QUEUED');
    await expect(lastAssistantMessage(claudeLocator())).resolves.toBeUndefined();
  });
});

describe('readFinishedTurns', () => {
  /** The cursors Pane knows for the tab: none, or one. */
  const known = (cursor: TranscriptCursor | undefined): TranscriptCursor[] => cursor ? [cursor] : [];
  const sessionId = '11111111-2222-4333-8444-555555555504';
  const tool = (id: string, timestamp: string) => claude.assistant(id, { type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: {} }, timestamp);
  const say = (id: string, text: string, timestamp: string) => claude.assistant(id, { type: 'text', text }, timestamp);
  const prompt = (text: string, timestamp: string) => claude.user(text, timestamp);
  // The agent writes more of its transcript; the file stays dated after its rows.
  const append = (file: string, rows: object[]) => {
    fs.appendFileSync(file, jsonl(rows));
    fs.utimesSync(file, writtenAt, writtenAt);
  };
  /** A transcript with an earlier turn, and the cursor Pane set at its end on first sight. */
  const afterEarlierTurn = async () => {
    const file = writeClaude(sessionId, [prompt('start', '2026-09-27T18:29:00.000Z'), say('msg_0', 'Earlier turn', '2026-09-27T18:30:00.000Z')]);
    const first = await readFinishedTurns(claudeLocator(), known(undefined), true);
    expect(first).toMatchObject({ missed: true, endedWithText: undefined });
    return { file, cursor: first.cursor };
  };

  it('credits a turn a Pane line started that ends with a reply', async () => {
    const { file, cursor } = await afterEarlierTurn();
    append(file, [
      claude.user('[From Pane, Workers] T-12 reported ready', '2026-09-27T18:40:00.100Z', { origin: { kind: 'pane' } }),
      tool('msg_1', '2026-09-27T18:40:01.000Z'),
      say('msg_2', 'T-12 is ready: PR 88 is green.', '2026-09-27T18:40:05.000Z'),
    ]);

    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: true });
  });

  it('credits a short turn whose reply was written before Pane even saw it working', async () => {
    const { file, cursor } = await afterEarlierTurn();
    // Prompt and reply both land before anything on the host reacts; the cursor is from the earlier judgment.
    append(file, [prompt('quick one', '2026-09-27T18:40:00.000Z'), say('msg_1', 'Done.', '2026-09-27T18:40:00.300Z')]);

    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: true });
  });

  it('does not credit an empty turn with the reply of the next turn, which started while it settled and is still working', async () => {
    const { file, cursor } = await afterEarlierTurn();
    // Turn A: a watcher wake the agent answered with nothing at all.
    append(file, [claude.user('<task-notification>watch: 0 events</task-notification>', '2026-09-27T18:40:00.000Z', { isMeta: true, origin: { kind: 'task-notification' } })]);
    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: false });
    // Turn B starts during A's settle and is still working when A is read again.
    append(file, [prompt('next', '2026-09-27T18:40:01.000Z'), say('msg_1', 'Starting on the review.', '2026-09-27T18:40:01.200Z')]);

    await expect(readFinishedTurns(claudeLocator(), known(cursor), false)).resolves.toMatchObject({ endedWithText: false });
  });

  it('is false for a turn that ends on a tool call, even after progress text, thinking or a blank reply', async () => {
    const { file, cursor } = await afterEarlierTurn();
    append(file, [
      prompt('check', '2026-09-27T18:40:00.000Z'),
      say('msg_1', 'Checking the workers.', '2026-09-27T18:40:01.000Z'),
      claude.assistant('msg_1', { type: 'thinking', thinking: 'nothing to say' }, '2026-09-27T18:40:01.500Z'),
      say('msg_2', '   ', '2026-09-27T18:40:02.000Z'),
      tool('msg_2', '2026-09-27T18:40:03.000Z'),
    ]);

    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: false });
  });

  it('ends a turn where the next one starts: a queued prompt 100 ms after idle and its text 200 ms after', async () => {
    const { file, cursor } = await afterEarlierTurn();
    append(file, [prompt('wake', '2026-09-27T18:40:00.000Z'), tool('msg_1', '2026-09-27T18:40:02.000Z')]);
    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: false });
    append(file, [prompt('next', '2026-09-27T18:40:04.100Z'), say('msg_2', 'Starting on the review.', '2026-09-27T18:40:04.200Z')]);
    await expect(readFinishedTurns(claudeLocator(), known(cursor), false)).resolves.toMatchObject({ endedWithText: false });
  });

  it('ends a turn where the agent starts its own next one, with a task notification it did not type', async () => {
    const { file, cursor } = await afterEarlierTurn();
    append(file, [
      prompt('wake', '2026-09-27T18:40:00.000Z'),
      tool('msg_1', '2026-09-27T18:40:02.000Z'),
      claude.user('<task-notification>Build finished</task-notification>', '2026-09-27T18:40:04.100Z', { isMeta: true, origin: { kind: 'task-notification' } }),
      say('msg_2', 'The build finished.', '2026-09-27T18:40:04.200Z'),
    ]);

    await expect(readFinishedTurns(claudeLocator(), known(cursor), false)).resolves.toMatchObject({ endedWithText: false });
  });

  it('goes by row order, not the clock: a clock set back mid-turn still finds the reply', async () => {
    const { file, cursor } = await afterEarlierTurn();
    append(file, [
      prompt('go', '2026-09-27T18:40:00.000Z'),
      tool('msg_1', '2026-09-27T17:40:01.000Z'),
      say('msg_2', 'Done, despite the clock.', '2026-09-27T17:40:02.000Z'),
    ]);

    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: true });
  });

  it('reads a transcript new to this Pane run from its start: a new Session\'s first reply bolds', async () => {
    // Before the file was made, even where dating the fixture back also dates its creation back (APFS).
    const runStartedAt = writtenAt.getTime() - 60_000;
    writeClaude(sessionId, [prompt('hello', '2026-09-27T18:40:00.000Z'), say('msg_1', 'Hi, on it.', '2026-09-27T18:40:01.000Z')]);
    await expect(readFinishedTurns(claudeLocator(), known(undefined), true, runStartedAt)).resolves.toMatchObject({ endedWithText: true });
  });

  it('after a restart that starts a new transcript, reads the new one from its start: its first reply bolds', async () => {
    // Before the file was made, even where dating the fixture back also dates its creation back (APFS).
    const runStartedAt = writtenAt.getTime() - 60_000;
    // The cursor saved before the restart names the old transcript.
    const before = { file: path.join(home, 'old-session.jsonl'), id: '1:1', offset: 4096 };
    writeClaude(sessionId, [prompt('[From Pane] resumed work', '2026-09-27T18:40:00.000Z'), say('msg_1', 'Back on it.', '2026-09-27T18:40:01.000Z')]);

    await expect(readFinishedTurns(claudeLocator(), known(before), true, runStartedAt)).resolves.toMatchObject({ endedWithText: true });
  });

  /** A → B → A in one Pane run: conversation A, /clear to a new B, /resume back to A. Returns the cursors Pane kept and A's file. */
  const backToA = async () => {
    const runStartedAt = writtenAt.getTime() - 60_000;
    const idB = '11111111-2222-4333-8444-5555555555b0';
    const locatorB: TranscriptLocator = { agent: 'claude', cwd: worktree, sessionId: idB };
    const fileA = writeClaude(sessionId, [prompt('first', '2026-09-27T18:40:00.000Z'), say('msg_1', 'A reply the person read.', '2026-09-27T18:40:01.000Z')]);
    const a = await readFinishedTurns(claudeLocator(), [], true, runStartedAt);
    expect(a.endedWithText).toBe(true);
    writeClaude(idB, [prompt('after /clear', '2026-09-27T18:45:00.000Z'), say('msg_2', 'B reply.', '2026-09-27T18:45:01.000Z')]);
    const b = await readFinishedTurns(locatorB, [a.cursor!], true, runStartedAt);
    expect(b.endedWithText).toBe(true);
    return { fileA, runStartedAt, kept: [a.cursor!, b.cursor!] };
  };

  it('A → B → A: back on A, a tool-only turn does not bold; A\'s own cursor is used, not a read from its start', async () => {
    const { fileA, runStartedAt, kept } = await backToA();
    append(fileA, [prompt('/resume', '2026-09-27T18:50:00.000Z'), tool('msg_3', '2026-09-27T18:50:01.000Z')]);

    await expect(readFinishedTurns(claudeLocator(), kept, true, runStartedAt)).resolves.toMatchObject({ endedWithText: false });
  });

  it('A → B → A: back on A, a new reply bolds', async () => {
    const { fileA, runStartedAt, kept } = await backToA();
    append(fileA, [prompt('/resume', '2026-09-27T18:50:00.000Z'), say('msg_3', 'A new reply on A.', '2026-09-27T18:50:01.000Z')]);

    await expect(readFinishedTurns(claudeLocator(), kept, true, runStartedAt)).resolves.toMatchObject({ endedWithText: true });
  });

  it('a resumed transcript that existed before this Pane run credits nothing until a fresh prompt', async () => {
    const file = writeClaude(sessionId, [prompt('old', '2026-09-27T18:29:00.000Z'), say('msg_0', 'An old reply the person read.', '2026-09-27T18:30:00.000Z')]);
    // Pane started after the file was made.
    const runStartedAt = Date.now() + 60_000;
    const first = await readFinishedTurns(claudeLocator(), known(undefined), true, runStartedAt);
    expect(first).toMatchObject({ missed: true, endedWithText: undefined });
    append(file, [prompt('next', '2026-09-27T18:41:00.000Z'), say('msg_2', 'A new reply.', '2026-09-27T18:41:05.000Z')]);
    await expect(readFinishedTurns(claudeLocator(), known(first.cursor), true, runStartedAt)).resolves.toMatchObject({ endedWithText: true });
  });

  it('with no cursor (a restart, a new transcript), credits nothing: a resumed transcript\'s history never bolds, nor rows before the next prompt', async () => {
    // Pane restarts; the resumed transcript already holds a reply the person read.
    const file = writeClaude(sessionId, [prompt('old', '2026-09-27T18:29:00.000Z'), say('msg_0', 'An old reply the person read long ago.', '2026-09-27T18:30:00.000Z')]);
    const first = await readFinishedTurns(claudeLocator(), known(undefined), true);
    expect(first).toMatchObject({ missed: true, endedWithText: undefined });
    // The turn that ended as Pane came back writes its rows late, with no prompt after the cursor: not credited.
    append(file, [say('msg_1', 'Late text of the turn before the cursor.', '2026-09-27T18:40:00.000Z')]);
    const late = await readFinishedTurns(claudeLocator(), known(first.cursor), true);
    expect(late.endedWithText).toBeUndefined();
    // A fresh prompt and its reply: that turn counts.
    append(file, [prompt('next', '2026-09-27T18:41:00.000Z'), say('msg_2', 'A new reply.', '2026-09-27T18:41:05.000Z')]);
    await expect(readFinishedTurns(claudeLocator(), known(late.cursor), true)).resolves.toMatchObject({ endedWithText: true });
  });

  it('starts over at the end of a transcript rewritten shorter at the same path, or replaced, and bolds the next new reply', async () => {
    const { file, cursor } = await afterEarlierTurn();
    // The transcript is rewritten in place, shorter than where the cursor stands.
    fs.writeFileSync(file, jsonl([prompt('compact', '2026-09-27T18:50:00.000Z')]));
    fs.utimesSync(file, writtenAt, writtenAt);
    const rewritten = await readFinishedTurns(claudeLocator(), known({ ...cursor!, offset: cursor!.offset + 10_000 }), true);
    expect(rewritten).toMatchObject({ missed: true, endedWithText: undefined });
    append(file, [prompt('after', '2026-09-27T18:51:00.000Z'), say('msg_3', 'Reply after the rewrite.', '2026-09-27T18:51:02.000Z')]);
    const afterReply = await readFinishedTurns(claudeLocator(), known(rewritten.cursor), true);
    expect(afterReply.endedWithText).toBe(true);

    // Replaced by another file at the same path (a new identity): the same.
    const replacement = `${file}.new`;
    fs.writeFileSync(replacement, jsonl([prompt('x', '2026-09-27T18:52:00.000Z'), say('msg_4', 'History in the new file.', '2026-09-27T18:52:01.000Z')]));
    fs.renameSync(replacement, file);
    fs.utimesSync(file, writtenAt, writtenAt);
    await expect(readFinishedTurns(claudeLocator(), known(afterReply.cursor), true)).resolves.toMatchObject({ missed: true, endedWithText: undefined });
  });

  it('moves the cursor past what it judged, and keeps a turn still working for the next read', async () => {
    const { file, cursor } = await afterEarlierTurn();
    append(file, [prompt('wake', '2026-09-27T18:40:00.000Z'), tool('msg_1', '2026-09-27T18:40:02.000Z'), prompt('next', '2026-09-27T18:40:04.000Z')]);
    const first = await readFinishedTurns(claudeLocator(), known(cursor), false);
    expect(first.endedWithText).toBe(false);
    append(file, [say('msg_2', 'The review is done.', '2026-09-27T18:40:09.000Z')]);

    await expect(readFinishedTurns(claudeLocator(), known(first.cursor), true)).resolves.toMatchObject({ endedWithText: true });
  });

  it('answers undefined with nothing finished since the cursor, and without a transcript', async () => {
    const { cursor } = await afterEarlierTurn();
    await expect(readFinishedTurns(claudeLocator(), known(cursor), true)).resolves.toMatchObject({ endedWithText: undefined });
    await expect(readFinishedTurns(codexLocator(), known(undefined), true)).resolves.toMatchObject({ endedWithText: undefined });
  });

  it('reads Codex replies and tool calls too', async () => {
    const file = writeCodex('01a0e428', [codex.meta(worktree, '2026-09-27T18:37:14.814Z')]);
    const start = await readFinishedTurns(codexLocator(), known(undefined), true);
    append(file, [codex.user('check', '2026-09-27T18:40:00.000Z'), codex.assistant('Watching the workers.', '2026-09-27T18:40:02.000Z')]);
    const first = await readFinishedTurns(codexLocator(), known(start.cursor), true);
    expect(first.endedWithText).toBe(true);

    append(file, [codex.user('again', '2026-09-27T18:41:00.000Z'), { timestamp: '2026-09-27T18:41:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' } }]);
    await expect(readFinishedTurns(codexLocator(), known(first.cursor), true)).resolves.toMatchObject({ endedWithText: false });
  });
});

describe('readTranscriptTail', () => {
  it('reads a large transcript from its tail, then only what was appended', async () => {
    const filler = claude.assistant('msg_filler', { type: 'text', text: 'f'.repeat(1_000) }, '2026-09-27T18:00:00.000Z');
    const file = writeClaude('11111111-2222-4333-8444-555555555504', [
      claude.user('The very first prompt', '2026-09-27T18:00:00.000Z'),
      ...Array.from({ length: 3_000 }, () => filler),
      claude.user('Reply with the single word OK', '2026-09-27T18:34:11.941Z'),
    ]);
    expect(fs.statSync(file).size).toBeGreaterThan(3 * 1024 * 1024);

    const entries = await readTranscriptTail(file, parseClaudeLine);
    expect(entries.some(entry => entry.text === 'The very first prompt')).toBe(false);
    expect(entries.at(-1)).toMatchObject({ kind: 'user', text: 'Reply with the single word OK' });
    expect(entries.length).toBeLessThanOrEqual(400);

    // A partial line is left for the next read.
    fs.appendFileSync(file, JSON.stringify(claude.user('Next prompt', '2026-09-27T18:35:00.000Z')).slice(0, 40));
    expect((await readTranscriptTail(file, parseClaudeLine)).at(-1)?.text).toBe('Reply with the single word OK');
    fs.appendFileSync(file, JSON.stringify(claude.user('Next prompt', '2026-09-27T18:35:00.000Z')).slice(40) + '\n');
    expect((await readTranscriptTail(file, parseClaudeLine)).at(-1)?.text).toBe('Next prompt');
  });
});

describe('parseClaudeLine on an API error', () => {
  it('reads the synthetic API error message as the last assistant reply', () => {
    expect(parseClaudeLine(CLAUDE_API_ENOTFOUND_TRANSCRIPT_LINE)).toMatchObject({
      kind: 'assistant',
      text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    });
  });
});
