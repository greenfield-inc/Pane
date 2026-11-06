import { z } from 'zod';
/** Every error code either API returns. Each one has a fixed HTTP status. */
export declare const ERROR_STATUS: {
    readonly invalid_request: 400;
    readonly operation_not_allowed: 400;
    readonly unauthenticated: 401;
    readonly signature_invalid: 401;
    readonly operation_expired: 401;
    readonly not_invited: 403;
    readonly not_machine_owner: 403;
    readonly not_team_owner: 403;
    readonly not_team_member: 403;
    readonly machine_not_found: 404;
    readonly invite_not_found: 404;
    readonly connection_code_not_found: 404;
    readonly operation_not_found: 404;
    readonly seat_has_machine: 409;
    readonly machine_exists: 409;
    readonly invalid_state: 409;
    readonly already_member: 409;
    readonly release_not_published: 422;
    readonly no_capacity: 503;
    readonly internal: 500;
};
export type CloudErrorCode = keyof typeof ERROR_STATUS;
/** The body of every non-2xx response: what happened, and the caller's next step. */
export declare const ErrorBody: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            invalid_request: "invalid_request";
            operation_not_allowed: "operation_not_allowed";
            unauthenticated: "unauthenticated";
            signature_invalid: "signature_invalid";
            operation_expired: "operation_expired";
            not_invited: "not_invited";
            not_machine_owner: "not_machine_owner";
            not_team_owner: "not_team_owner";
            not_team_member: "not_team_member";
            machine_not_found: "machine_not_found";
            invite_not_found: "invite_not_found";
            connection_code_not_found: "connection_code_not_found";
            operation_not_found: "operation_not_found";
            seat_has_machine: "seat_has_machine";
            machine_exists: "machine_exists";
            invalid_state: "invalid_state";
            already_member: "already_member";
            release_not_published: "release_not_published";
            no_capacity: "no_capacity";
            internal: "internal";
        }>;
        message: z.ZodString;
        next: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type ErrorBody = z.infer<typeof ErrorBody>;
/** Thrown by the clients for an error response, and by the stubs to send one. */
export declare class CloudApiError extends Error {
    readonly code: CloudErrorCode;
    readonly next: string;
    readonly status: number;
    constructor(code: CloudErrorCode, message: string, next: string);
    toBody(): ErrorBody;
}
/** Thrown by the clients when a server's response does not match the contract. */
export declare class ContractViolationError extends Error {
    readonly route: string;
    readonly detail: string;
    constructor(route: string, detail: string);
}
