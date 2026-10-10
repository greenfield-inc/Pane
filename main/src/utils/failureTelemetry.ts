import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
const ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EMFILE', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ERR_RUNPANE_PANE_CREATE_FAILED', 'ERR_RUNPANE_BRANCH_HAS_PANE']);

export function failureDetails(cause: unknown) {
  const name = cause instanceof Error ? cause.name : undefined;
  let code: string | undefined;
  let message = '';
  try {
    const parsed = decodeBoundary(cause, boundary.object({
      code: boundary.optional(boundary.string),
      message: boundary.optional(boundary.string),
    }));
    code = parsed.code;
    message = parsed.message?.slice(0, 4096) ?? '';
  } catch {
    // Non-error throws carry no safe classification context.
  }
  const errorCode = code && ERROR_CODES.has(code) ? code : 'unknown';
  const text = `${errorCode} ${message}`.toLowerCase();
  const category = /eacces|eperm|permission/.test(text) ? 'permission'
    : /enospc|emfile|eio/.test(text) ? 'io'
    : /timeout|timed out|etimedout/.test(text) ? 'timeout'
    : /econn|enotfound|network|socket/.test(text) ? 'network'
    : /enoent|not found|no pane .*found/.test(text) ? 'not_found'
    : /invalid|required|must be|cannot include/.test(text) ? 'validation'
    : 'unknown';
  return {
    error_type: name && ERROR_TYPES.has(name) ? name : 'Error',
    error_code: errorCode,
    failure_category: category,
  };
}

/** In-memory only: one report per signature per five minutes, at most 20/hour. */
export class FailureLimiter {
  private windowStart = Date.now();
  private count = 0;
  private lastReports = new Map<string, number>();

  allow(key: string): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 60 * 60 * 1000) {
      this.windowStart = now;
      this.count = 0;
      // Keep recent signatures suppressed across the hourly boundary. At most
      // 20 carried signatures plus this hour's 20 reports can remain in memory.
      for (const [signature, reportedAt] of this.lastReports) {
        if (now - reportedAt >= 5 * 60 * 1000) this.lastReports.delete(signature);
      }
    }
    const last = this.lastReports.get(key);
    if (this.count >= 20 || (last !== undefined && now - last < 5 * 60 * 1000)) return false;
    this.lastReports.set(key, now);
    this.count++;
    return true;
  }
}
