import { describe, expect, it, vi } from 'vitest';
import type { FinishedTurns, TranscriptCursor, TranscriptLocator } from './agentTranscript';
import { createReplyProbe, type ReplyProbeSources } from './sessionReply';

const locator: TranscriptLocator = { agent: 'claude', cwd: '/work/session' };
const file = '/home/.claude/projects/work-session/s.jsonl';
const at = (offset: number): TranscriptCursor => ({ file, offset });
const finished = (endedWithText: boolean | undefined, cursor = at(100)): FinishedTurns => ({ endedWithText, cursor });

function sources(overrides: Partial<ReplyProbeSources>): ReplyProbeSources {
  return {
    agentTypeOf: () => 'claude',
    locatorOf: () => locator,
    isIdle: () => true,
    readTurns: async () => finished(true),
    wait: async () => undefined,
    ...overrides,
  };
}

describe('the reply probe for a terminal Session agent', () => {
  it('reads the turns finished since its last judgment, from where that one stopped', async () => {
    const readTurns = vi.fn(async (_locator: TranscriptLocator, cursor: TranscriptCursor | undefined) => finished(true, at((cursor?.offset ?? 0) + 100)));
    const probe = createReplyProbe(sources({ readTurns }));

    await expect(probe.turnEnded('panel')).resolves.toBe(true);
    await expect(probe.turnEnded('panel')).resolves.toBe(true);
    // The first judgment reads with no cursor; the next starts where the first one stopped.
    expect(readTurns.mock.calls.map(call => call[1])).toEqual([undefined, undefined, at(100), at(100)]);
  });

  it('tells the reader whether the tab is idle at each read, so a turn still working never counts', async () => {
    const readTurns = vi.fn(async () => finished(false));
    await createReplyProbe(sources({ readTurns, isIdle: () => false })).turnEnded('panel');
    expect(readTurns.mock.calls.every(call => call[2] === false)).toBe(true);
  });

  it('settles a positive read before believing it: progress text seen first, its tool call only on the next read, is no reply', async () => {
    const reads = [true, false, false, false].map(value => finished(value));
    const wait = vi.fn(async () => undefined);
    await expect(createReplyProbe(sources({ readTurns: async () => reads.shift()!, wait })).turnEnded('panel')).resolves.toBe(false);
    expect(wait).toHaveBeenCalled();
  });

  it('waits for a transcript written just after the tab went idle, and gives up without evidence', async () => {
    const delayed = [undefined, undefined, true, true].map(value => finished(value));
    await expect(createReplyProbe(sources({ readTurns: async () => delayed.shift()! })).turnEnded('panel')).resolves.toBe(true);

    // Never found: no evidence of a message, so no bold, and the cursor stays where it was.
    const readTurns = vi.fn(async () => finished(undefined, at(500)));
    const probe = createReplyProbe(sources({ readTurns }));
    await expect(probe.turnEnded('panel')).resolves.toBe(false);
    await probe.turnEnded('panel');
    expect(readTurns.mock.calls.every(call => call[1] === undefined)).toBe(true);

    // Unreadable, or nowhere to look: no evidence either.
    await expect(createReplyProbe(sources({ readTurns: async () => { throw new Error('EACCES'); } })).turnEnded('panel')).resolves.toBe(false);
    await expect(createReplyProbe(sources({ locatorOf: () => undefined })).turnEnded('panel')).resolves.toBe(false);
  });

  it('counts every finished turn of a terminal agent Pane has no transcript reader for (a documented limit, D-2)', async () => {
    const readTurns = vi.fn(async () => finished(false));
    await expect(createReplyProbe(sources({ agentTypeOf: () => 'cursor', readTurns })).turnEnded('panel')).resolves.toBe(true);
    await expect(createReplyProbe(sources({ agentTypeOf: () => undefined, readTurns })).turnEnded('panel')).resolves.toBe(true);
    expect(readTurns).not.toHaveBeenCalled();
  });
});
