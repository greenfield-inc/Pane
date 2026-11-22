import { z } from 'zod';
/** Every error code either API returns. Each one has a fixed HTTP status. */
export declare const ERROR_STATUS: {
    readonly invalid_request: 400;
    readonly operation_not_allowed: 400;
    readonly unauthenticated: 401;
    readonly signature_invalid: 401;
    readonly operation_expired: 401;
    readonly not_invited: 403;
    readonly signup_incomplete: 403;
    readonly not_org_member: 403;
    readonly under_review: 403;
    readonly view_only: 403;
    readonly vm_not_found: 404;
    readonly operation_not_found: 404;
    readonly invalid_state: 409;
    readonly vm_exists: 409;
    readonly awake_limit_reached: 409;
    readonly wrong_host: 421;
    readonly relay_key_changed: 409;
    readonly client_update_required: 426;
    readonly release_not_published: 422;
    readonly internal: 500;
    readonly no_capacity: 503;
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
            signup_incomplete: "signup_incomplete";
            not_org_member: "not_org_member";
            under_review: "under_review";
            view_only: "view_only";
            vm_not_found: "vm_not_found";
            operation_not_found: "operation_not_found";
            invalid_state: "invalid_state";
            vm_exists: "vm_exists";
            awake_limit_reached: "awake_limit_reached";
            wrong_host: "wrong_host";
            relay_key_changed: "relay_key_changed";
            client_update_required: "client_update_required";
            release_not_published: "release_not_published";
            internal: "internal";
            no_capacity: "no_capacity";
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
