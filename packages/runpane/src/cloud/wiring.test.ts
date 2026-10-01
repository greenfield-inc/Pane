import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCloudStopSafeToStop } from './wiring';

describe('cloud stop safe-to-stop answer', () => {
  const flush = { walCheckpoint: { busy: 0, log: 1, checkpointed: 1 }, fsynced: [], syncedFilesystem: true, durationMs: 4 };

  it('counts the daemon as flushed only when it verified the flush durable', () => {
    assert.equal(decodeCloudStopSafeToStop({ safe: true, blockers: [], flush: { ...flush, durable: true, failures: [] } }).flushed, true);
    assert.equal(decodeCloudStopSafeToStop({ safe: false, blockers: [], flush: { ...flush, durable: false, failures: ['sync failed'] } }).flushed, false);
    // A daemon from before `durable` gets the plain sync fallback.
    assert.equal(decodeCloudStopSafeToStop({ safe: true, blockers: [], flush }).flushed, false);
    assert.equal(decodeCloudStopSafeToStop({ safe: true, blockers: [], flush: null }).flushed, false);
  });
});
