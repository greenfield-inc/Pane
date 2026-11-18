import { expect, it } from 'vitest';

// Throwaway probe for PR #1519, reverted before merge: fails on its first
// call and passes on any retry, so it shows whether CI still retries.
let calls = 0;

it('fails on its first call only', () => {
  calls += 1;
  expect(calls).toBeGreaterThan(1);
});
