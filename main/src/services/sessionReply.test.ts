import { describe, expect, it, vi } from 'vitest';
import type { FinishedTurns, TranscriptCursor, TranscriptLocator } from './agentTranscript';
import { createReplyProbe, type ReplyProbeSources } from './sessionReply';

const locator: TranscriptLocator = { agent: 'claude', cwd: '/work/session' };
const file = '/home/.claude/projects/work-session/s.jsonl';
const at = (offset: number): TranscriptCursor => ({ file, id: '1:42', offset });
const finished = (endedWithText: boolean | undefined, cursor = at(100)): FinishedTurns => ({ endedWithText, cursor });

/** Cursors saved with the Session, as the host keeps them across restarts. */
const saved = new Map<string, TranscriptCursor>();

function sources(overrides: Partial<ReplyProbeSources>): ReplyProbeSources {
  return {
    agentTypeOf: () => 'claude',
    locatorOf: () => locator,
    isIdle: () => true,
    readTurns: async () => finished(true),
    wait: async () => undefined,
    loadCursor: async () => undefined,
    saveCursor: async (panelId, cursor) => { saved.set(panelId, cursor); },
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

  it('saves the cursor with the Session and starts from it after a restart', async () => {
    saved.clear();
    const readTurns = vi.fn(async () => finished(false, at(700)));
    await createReplyProbe(sources({ readTurns })).turnEnded('panel');
    expect(saved.get('panel')).toEqual(at(700));

    // A new probe (Pane restarted) loads it.
    const after = vi.fn(async () => finished(false, at(800)));
    await createReplyProbe(sources({ readTurns: after, loadCursor: async panelId => saved.get(panelId) })).turnEnded('panel');
    expect(after.mock.calls[0][1]).toEqual(at(700));
  });

  it('on a cursor miss (no cursor, another transcript, a rewrite) saves the new start and credits nothing, without settling', async () => {
    saved.clear();
    const readTurns = vi.fn(async () => ({ endedWithText: undefined, cursor: at(900), missed: true }));
    await expect(createReplyProbe(sources({ readTurns })).turnEnded('panel')).resolves.toBe(false);
    expect(readTurns).toHaveBeenCalledTimes(1);
    expect(saved.get('panel')).toEqual(at(900));
  });

  it('runs one judgment at a time per tab: a turn that ends meanwhile waits and starts where the first one stopped', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    // Turn A ended with a reply (rows up to 100); turn B, read from there, ended with tool calls only.
    const readTurns = vi.fn(async (_locator: TranscriptLocator, cursor: TranscriptCursor | undefined) => cursor?.offset === 100 ? finished(false, at(200)) : finished(true, at(100)));
    const probe = createReplyProbe(sources({ readTurns, loadCursor: async () => at(0), wait: () => held }));

    const a = probe.turnEnded('panel');
    const b = probe.turnEnded('panel');
    await vi.waitFor(() => expect(readTurns).toHaveBeenCalledTimes(1));
    release();
    await expect(a).resolves.toBe(true);
    // B never read A's rows again, so it did not credit A's reply to itself.
    await expect(b).resolves.toBe(false);
    expect(readTurns.mock.calls.map(call => call[1]?.offset)).toEqual([0, 0, 100, 100, 100, 100]);
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

    // A positive read on the last try, with no read after it to agree, is not believed either.
    const lastOnly = [false, false, false, true].map(value => finished(value));
    await expect(createReplyProbe(sources({ readTurns: async () => lastOnly.shift()! })).turnEnded('panel')).resolves.toBe(false);
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
