import { z } from 'zod';

/** Every error code either API returns. Each one has a fixed HTTP status. */
export const ERROR_STATUS = {
  invalid_request: 400,
  operation_not_allowed: 400,
  unauthenticated: 401,
  signature_invalid: 401,
  operation_expired: 401,
  payment_required: 402,
  not_invited: 403,
  not_machine_owner: 403,
  not_team_owner: 403,
  not_team_member: 403,
  machine_not_found: 404,
  invite_not_found: 404,
  connection_code_not_found: 404,
  operation_not_found: 404,
  seat_has_machine: 409,
  machine_exists: 409,
  invalid_state: 409,
  already_member: 409,
  release_not_published: 422,
  no_capacity: 503,
  internal: 500,
} as const;

export type CloudErrorCode = keyof typeof ERROR_STATUS;

// SAFETY: Object.keys of a non-empty object literal lists exactly its keys.
const errorCodes = Object.keys(ERROR_STATUS) as [CloudErrorCode, ...CloudErrorCode[]];

/** The body of every non-2xx response: what happened, and the caller's next step. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(errorCodes),
    message: z.string().min(1),
    next: z.string().min(1),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Thrown by the clients for an error response, and by the stubs to send one. */
export class CloudApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: CloudErrorCode,
    message: string,
    readonly next: string,
  ) {
    super(message);
    this.name = 'CloudApiError';
    this.status = ERROR_STATUS[code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, next: this.next } };
  }
}

/** Thrown by the clients when a server's response does not match the contract. */
export class ContractViolationError extends Error {
  constructor(
    readonly route: string,
    readonly detail: string,
  ) {
    super(`${route} answered outside the contract: ${detail}`);
    this.name = 'ContractViolationError';
  }
}
