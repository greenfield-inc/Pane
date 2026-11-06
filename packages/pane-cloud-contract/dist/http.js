"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.route = route;
exports.callRoute = callRoute;
const zod_1 = require("zod");
const errors_1 = require("./errors");
function route(definition) {
    return {
        id: definition.id,
        method: definition.method,
        path: definition.path,
        auth: definition.auth,
        body: definition.body ?? null,
        query: definition.query ?? null,
        response: definition.response,
        status: definition.status ?? 200,
    };
}
const QueryValues = zod_1.z.record(zod_1.z.string(), zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.undefined()]));
function fillPath(path, params = {}) {
    return path.replace(/:([A-Za-z]+)/g, (_match, name) => {
        const value = params[name];
        if (value === undefined)
            throw new Error(`Missing path parameter "${name}" for ${path}`);
        return encodeURIComponent(value);
    });
}
/**
 * Calls one route and returns its parsed response. Throws CloudApiError for an error the server
 * reported, and ContractViolationError for any response outside the contract.
 */
async function callRoute(config, target, input = {}) {
    const url = new URL(config.baseUrl.replace(/\/$/, '') + fillPath(target.path, input.params));
    for (const [key, value] of Object.entries(QueryValues.parse(input.query ?? {}))) {
        if (value !== undefined)
            url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ accept: 'application/json' });
    if (config.token)
        headers.set('authorization', `Bearer ${config.token}`);
    let body;
    if (input.body !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(input.body);
    }
    const response = await (config.fetch ?? fetch)(url, { method: target.method, headers, body });
    const text = await response.text();
    let json;
    try {
        json = text === '' ? undefined : zod_1.z.json().parse(JSON.parse(text));
    }
    catch {
        throw new errors_1.ContractViolationError(target.id, `status ${response.status} with a body that is not JSON`);
    }
    if (response.status !== target.status) {
        const error = errors_1.ErrorBody.safeParse(json);
        if (!error.success || response.status < 400) {
            throw new errors_1.ContractViolationError(target.id, `unexpected status ${response.status}`);
        }
        const { code, message, next } = error.data.error;
        const thrown = new errors_1.CloudApiError(code, message, next);
        if (thrown.status !== response.status) {
            throw new errors_1.ContractViolationError(target.id, `error ${code} sent with status ${response.status}, not ${thrown.status}`);
        }
        throw thrown;
    }
    const parsed = target.response.safeParse(json);
    if (!parsed.success)
        throw new errors_1.ContractViolationError(target.id, zod_1.z.prettifyError(parsed.error));
    // SAFETY: target.response is the schema RouteResponse<T> is inferred from, and it just parsed the body.
    return parsed.data;
}
