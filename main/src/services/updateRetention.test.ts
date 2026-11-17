import { describe, expect, it } from 'vitest';
import { replacedUpdates } from '../../../packages/runpane/src/updateRetention';

describe('replacedUpdates', () => {
  it('removes every update older than the newest completed one, whatever its outcome', () => {
    const replaced = replacedUpdates([
      { id: 'u1', phase: 'complete', updatedAt: Date.parse('2026-10-01') },
      { id: 'u2', phase: 'needs-attention', updatedAt: Date.parse('2026-10-31') },
      { id: 'u3', phase: 'complete', updatedAt: Date.parse('2026-11-10') },
      { id: 'u4', phase: 'failed', updatedAt: Date.parse('2026-11-12') },
      { id: 'u5', phase: 'install', updatedAt: Date.parse('2026-11-15') },
    ]);
    expect(replaced).toEqual(['u1', 'u2']);
  });

  it('keeps everything until one update has completed', () => {
    expect(replacedUpdates([
      { id: 'u1', phase: 'needs-attention', updatedAt: 1 },
      { id: 'u2', phase: 'failed', updatedAt: 2 },
    ])).toEqual([]);
  });
});
