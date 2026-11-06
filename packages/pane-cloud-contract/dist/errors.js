"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContractViolationError = exports.CloudApiError = exports.ErrorBody = exports.ERROR_STATUS = void 0;
const zod_1 = require("zod");
/** Every error code either API returns. Each one has a fixed HTTP status. */
exports.ERROR_STATUS = {
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
};
// SAFETY: Object.keys of a non-empty object literal lists exactly its keys.
const errorCodes = Object.keys(exports.ERROR_STATUS);
/** The body of every non-2xx response: what happened, and the caller's next step. */
exports.ErrorBody = zod_1.z.object({
    error: zod_1.z.object({
        code: zod_1.z.enum(errorCodes),
        message: zod_1.z.string().min(1),
        next: zod_1.z.string().min(1),
    }),
});
/** Thrown by the clients for an error response, and by the stubs to send one. */
class CloudApiError extends Error {
    code;
    next;
    status;
    constructor(code, message, next) {
        super(message);
        this.code = code;
        this.next = next;
        this.name = 'CloudApiError';
        this.status = exports.ERROR_STATUS[code];
    }
    toBody() {
        return { error: { code: this.code, message: this.message, next: this.next } };
    }
}
exports.CloudApiError = CloudApiError;
/** Thrown by the clients when a server's response does not match the contract. */
class ContractViolationError extends Error {
    route;
    detail;
    constructor(route, detail) {
        super(`${route} answered outside the contract: ${detail}`);
        this.route = route;
        this.detail = detail;
        this.name = 'ContractViolationError';
    }
}
exports.ContractViolationError = ContractViolationError;
