import { describe, expect, it, vi } from 'vitest';
import type { TranscriptLocator } from './agentTranscript';
import { createReplyProbe, type ReplyProbeSources } from './sessionReply';

const turn = { startedAtMs: Date.parse('2026-11-26T10:00:00.000Z'), endedAtMs: Date.parse('2026-11-26T10:00:30.000Z') };
const locator: TranscriptLocator = { agent: 'claude', cwd: '/work/session' };

function sources(overrides: Partial<ReplyProbeSources>): ReplyProbeSources {
  return {
    agentTypeOf: () => 'claude',
    locatorOf: () => locator,
    readTurn: async () => true,
    wait: async () => undefined,
    ...overrides,
  };
}

describe('the reply probe for a terminal Session agent', () => {
  it('counts a Claude or Codex turn only on text the transcript shows, read within the turn', async () => {
    const readTurn = vi.fn(async () => true);
    await expect(createReplyProbe(sources({ readTurn }))('panel', turn)).resolves.toBe(true);
    expect(readTurn).toHaveBeenCalledWith(locator, turn.startedAtMs, turn.endedAtMs);

    await expect(createReplyProbe(sources({ readTurn: async () => false }))('panel', turn)).resolves.toBe(false);
  });

  it('waits for a transcript written just after the tab went idle, and gives up without evidence', async () => {
    const delayed = [undefined, undefined, true];
    const wait = vi.fn(async () => undefined);
    await expect(createReplyProbe(sources({ readTurn: async () => delayed.shift(), wait }))('panel', turn)).resolves.toBe(true);
    expect(wait).toHaveBeenCalledTimes(2);

    // Never found: no evidence of a message, so no bold.
    await expect(createReplyProbe(sources({ readTurn: async () => undefined }))('panel', turn)).resolves.toBe(false);
    // Unreadable, or nowhere to look: no evidence either.
    await expect(createReplyProbe(sources({ readTurn: async () => { throw new Error('EACCES'); } }))('panel', turn)).resolves.toBe(false);
    await expect(createReplyProbe(sources({ locatorOf: () => undefined }))('panel', turn)).resolves.toBe(false);
  });

  it('counts every finished turn of a terminal agent Pane has no transcript reader for (a documented limit)', async () => {
    const readTurn = vi.fn(async () => false);
    await expect(createReplyProbe(sources({ agentTypeOf: () => 'cursor', readTurn }))('panel', turn)).resolves.toBe(true);
    await expect(createReplyProbe(sources({ agentTypeOf: () => undefined, readTurn }))('panel', turn)).resolves.toBe(true);
    expect(readTurn).not.toHaveBeenCalled();
  });
});
