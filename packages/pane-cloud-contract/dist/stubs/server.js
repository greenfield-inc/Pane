"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bind = bind;
exports.createRouteServer = createRouteServer;
exports.listen = listen;
const node_http_1 = require("node:http");
const zod_1 = require("zod");
const errors_1 = require("../errors");
function bind(target, handle) {
    // SAFETY: the server only calls handle with input parsed by target's own schemas.
    return { route: target, handle: handle };
}
const JsonBody = zod_1.z.json();
function matchPath(pattern, path) {
    const want = pattern.split('/');
    const got = path.split('/');
    if (want.length !== got.length)
        return null;
    const params = {};
    for (let i = 0; i < want.length; i += 1) {
        const segment = want[i] ?? '';
        const actual = got[i] ?? '';
        if (segment.startsWith(':'))
            params[segment.slice(1)] = decodeURIComponent(actual);
        else if (segment !== actual)
            return null;
    }
    return params;
}
async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) {
        // SAFETY: an IncomingMessage with no encoding set yields Buffer chunks.
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '')
        return undefined;
    try {
        return JsonBody.parse(JSON.parse(text));
    }
    catch {
        throw new errors_1.CloudApiError('invalid_request', 'The request body is not JSON.', 'Send a JSON body.');
    }
}
function send(response, status, json) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(json);
}
function check(what, schema, value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new errors_1.CloudApiError('invalid_request', `The ${what} does not match the contract: ${zod_1.z.prettifyError(parsed.error)}`, 'Fix the request to match the contract and send it again.');
    }
    return parsed.data;
}
/**
 * An HTTP server for a list of bound routes. It checks each request against its route's schemas and
 * each handler's answer against the route's response schema, so a stub cannot drift from the contract.
 */
function createRouteServer(routes) {
    return (0, node_http_1.createServer)((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? '/', 'http://stub');
            try {
                let matched = null;
                for (const bound of routes) {
                    if (bound.route.method !== request.method)
                        continue;
                    const params = matchPath(bound.route.path, url.pathname);
                    if (params) {
                        matched = { bound, params };
                        break;
                    }
                }
                if (!matched)
                    throw new errors_1.CloudApiError('invalid_request', `No route for ${request.method} ${url.pathname}.`, 'Check the method and path against the contract.');
                const { route: target, handle } = matched.bound;
                const authorization = request.headers.authorization ?? '';
                const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
                if (target.auth && !token)
                    throw new errors_1.CloudApiError('unauthenticated', 'This call needs a signed-in account.', 'Sign in and send the token as a Bearer token.');
                const rawBody = await readJson(request);
                const body = target.body ? check('body', target.body, rawBody) : undefined;
                const query = target.query ? check('query', target.query, Object.fromEntries(url.searchParams)) : {};
                const result = await handle({ params: matched.params, body, query, token });
                const answer = target.response.safeParse(result);
                if (!answer.success)
                    throw new Error(`stub answered ${target.id} outside the contract: ${zod_1.z.prettifyError(answer.error)}`);
                send(response, target.status, JSON.stringify(answer.data));
            }
            catch (error) {
                const failure = error instanceof errors_1.CloudApiError ? error : new errors_1.CloudApiError('internal', error instanceof Error ? error.message : String(error), 'This is a stub bug; report it.');
                send(response, failure.status, JSON.stringify(failure.toBody()));
            }
        })();
    });
}
async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}
