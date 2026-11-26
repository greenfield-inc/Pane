import { describe, expect, it, vi } from 'vitest';
import type { TranscriptLocator, TranscriptMark } from './agentTranscript';
import { createReplyProbe, type ReplyProbeSources } from './sessionReply';

const turn = { startedAtMs: Date.parse('2026-11-26T10:00:00.000Z'), endedAtMs: Date.parse('2026-11-26T10:00:30.000Z') };
const locator: TranscriptLocator = { agent: 'claude', cwd: '/work/session' };
const start: TranscriptMark = { file: '/home/.claude/projects/work-session/s.jsonl', size: 4096 };

function sources(overrides: Partial<ReplyProbeSources>): ReplyProbeSources {
  return {
    agentTypeOf: () => 'claude',
    locatorOf: () => locator,
    mark: async () => start,
    readTurn: async () => true,
    wait: async () => undefined,
    ...overrides,
  };
}

/** A probe told the turn started, then asked how it ended. */
async function endedWithText(source: ReplyProbeSources): Promise<boolean> {
  const probe = createReplyProbe(source);
  probe.turnStarted('panel');
  return probe.turnEnded('panel', turn);
}

describe('the reply probe for a terminal Session agent', () => {
  it('reads the turn from where it started in the transcript, and counts it only on text it shows', async () => {
    const readTurn = vi.fn(async () => true);
    await expect(endedWithText(sources({ readTurn }))).resolves.toBe(true);
    expect(readTurn).toHaveBeenCalledWith(locator, start);

    await expect(endedWithText(sources({ readTurn: async () => false }))).resolves.toBe(false);
  });

  it('falls back to the turn\'s start time when Pane could not mark where it started', async () => {
    const readTurn = vi.fn(async () => true);
    await expect(endedWithText(sources({ mark: async () => undefined, readTurn }))).resolves.toBe(true);
    expect(readTurn).toHaveBeenCalledWith(locator, { startedAtMs: turn.startedAtMs });
  });

  it('settles a positive read before believing it: progress text seen first, its tool call only on the next read, is no reply', async () => {
    const reads = [true, false, false, false];
    const wait = vi.fn(async () => undefined);
    await expect(endedWithText(sources({ readTurn: async () => reads.shift(), wait }))).resolves.toBe(false);
    expect(wait).toHaveBeenCalled();
  });

  it('waits for a transcript written just after the tab went idle, and gives up without evidence', async () => {
    const delayed = [undefined, undefined, true, true];
    await expect(endedWithText(sources({ readTurn: async () => delayed.shift() }))).resolves.toBe(true);

    // Never found: no evidence of a message, so no bold.
    await expect(endedWithText(sources({ readTurn: async () => undefined }))).resolves.toBe(false);
    // Unreadable, or nowhere to look: no evidence either.
    await expect(endedWithText(sources({ readTurn: async () => { throw new Error('EACCES'); } }))).resolves.toBe(false);
    await expect(endedWithText(sources({ locatorOf: () => undefined }))).resolves.toBe(false);
  });

  it('counts every finished turn of a terminal agent Pane has no transcript reader for (a documented limit, D-2)', async () => {
    const readTurn = vi.fn(async () => false);
    await expect(endedWithText(sources({ agentTypeOf: () => 'cursor', readTurn }))).resolves.toBe(true);
    await expect(endedWithText(sources({ agentTypeOf: () => undefined, readTurn }))).resolves.toBe(true);
    expect(readTurn).not.toHaveBeenCalled();
  });
});
