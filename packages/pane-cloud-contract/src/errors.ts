import { z } from 'zod';

/** Every error code either API returns. Each one has a fixed HTTP status. */
export const ERROR_STATUS = {
  invalid_request: 400,
  operation_not_allowed: 400,
  unauthenticated: 401,
  signature_invalid: 401,
  operation_expired: 401,
  not_invited: 403,
  signup_incomplete: 403,
  not_org_member: 403,
  under_review: 403,
  vm_not_found: 404,
  operation_not_found: 404,
  invalid_state: 409,
  vm_exists: 409,
  awake_limit_reached: 409,
  release_not_published: 422,
  internal: 500,
  no_capacity: 503,
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
