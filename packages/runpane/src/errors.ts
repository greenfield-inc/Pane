/**
 * How runpane reports a failure, to people and agents alike: `message` says what happened, why
 * (the underlying reason, kept), and what was or was not changed; `next` is the exact step to take.
 * See "How Pane reports errors" in CONTRIBUTING.md.
 */
export interface RunpaneFailure {
  code: string;
  message: string;
  next?: string;
}

export class RunpaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next?: string,
  ) {
    super(message);
    this.name = 'RunpaneError';
  }
}

/** Any thrown value as a failure. Errors that carry a string `code` or `next` (Node, daemon, RunpaneError) keep them. */
export function describeFailure(error: unknown): RunpaneFailure {
  if (!(error instanceof Error)) return { code: 'ERR_RUNPANE_FAILED', message: String(error) };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'ERR_RUNPANE_FAILED';
  const next = 'next' in error && typeof error.next === 'string' ? error.next : undefined;
  return { code, message: error.message, ...(next ? { next } : {}) };
}

/** People read stderr; with --json, stdout also carries `{ ok: false, error: { code, message, next } }`. */
export function printFailure(error: unknown, json: boolean): void {
  const failure = describeFailure(error);
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: failure }, null, 2)}\n`);
  process.stderr.write(`${failure.next ? `${failure.message}\nNext: ${failure.next}` : failure.message}\n`);
}
