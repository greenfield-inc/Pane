import assert from 'node:assert/strict';
import { CloudApiError, type CloudErrorCode } from '../errors';

/** One contract check. Run each with your own test framework: `for (const c of cases) test(c.name, c.run)`. */
export interface ContractCase {
  name: string;
  run(): Promise<void>;
}

export async function expectError(code: CloudErrorCode, call: () => Promise<object>): Promise<void> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof CloudApiError, `expected CloudApiError ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected the call to fail with ${code}, and it succeeded`);
}

/** Polls `read` until `done` holds, so the same case passes on an instant stub and a real fleet. */
export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(20, timeoutMs / 100))));
  }
}
