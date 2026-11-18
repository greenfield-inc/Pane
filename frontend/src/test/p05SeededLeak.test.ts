import { expect, it } from 'vitest';

// Throwaway (P05): proves the shared-worker guard turns the run red. Reverted before review.
it('leaves a global and an env var behind for the next file', () => {
  Reflect.set(globalThis, 'p05SeededLeak', true);
  process.env.P05_SEEDED_LEAK = '1';
  expect(Reflect.get(globalThis, 'p05SeededLeak')).toBe(true);
});
