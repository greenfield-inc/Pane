import { describe, expect, it } from 'vitest';

// CI probe (not for merge): a deliberate failure proves CI result still turns red.
describe('ci probe', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
