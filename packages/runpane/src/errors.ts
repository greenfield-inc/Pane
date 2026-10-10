import { boundary, decodeBoundary } from './boundaryDecoder';

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
export function describeFailure(cause: unknown): RunpaneFailure {
  if (!(cause instanceof Error)) return { code: 'ERR_RUNPANE_FAILED', message: String(cause) };
  const { code, next } = errorFieldsOf(cause);
  const failure: RunpaneFailure = { code: code ?? 'ERR_RUNPANE_FAILED', message: cause.message };
  if (next) failure.next = next;
  return failure;
}

const errorFieldsSchema = boundary.object({ code: boundary.optional(boundary.string), next: boundary.optional(boundary.string) });

function errorFieldsOf(error: Error): Partial<Pick<RunpaneFailure, 'code' | 'next'>> {
  try {
    return decodeBoundary(error, errorFieldsSchema);
  } catch {
    return {};
  }
}

/** People read stderr; with --json, stdout also carries `{ ok: false, error: { code, message, next } }`. */
export function printFailure(cause: unknown, json: boolean): void {
  const failure = describeFailure(cause);
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: failure }, null, 2)}\n`);
  process.stderr.write(`${failure.next ? `${failure.message}\nNext: ${failure.next}` : failure.message}\n`);
}
