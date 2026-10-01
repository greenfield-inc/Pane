import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

/**
 * A command failure with a stable machine-readable code. The local daemon
 * socket and the remote HTTP API return `code` and `details` with the
 * message, so `runpane --json` can print a structured error.
 */
export class PaneCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, JsonValue> = {},
  ) {
    super(message);
    this.name = 'PaneCommandError';
  }
}
