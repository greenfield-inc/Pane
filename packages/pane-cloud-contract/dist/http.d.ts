import { z } from 'zod';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type NoQuery = z.ZodObject<Record<never, never>>;
/**
 * One endpoint of either API. `path` uses `:name` placeholders. The client and the stub servers both
 * read these, so a route's schemas are the contract for its request and its success response.
 */
export interface Route<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
    readonly id: string;
    readonly method: HttpMethod;
    readonly path: string;
    /** Whether the request must carry `Authorization: Bearer <token>`. */
    readonly auth: boolean;
    readonly body: B | null;
    readonly query: Q | null;
    readonly response: R;
    /** The status of a success response. */
    readonly status: number;
}
export declare function route<R extends z.ZodType, B extends z.ZodType = z.ZodUndefined, Q extends z.ZodType = NoQuery>(definition: {
    id: string;
    method: HttpMethod;
    path: string;
    auth: boolean;
    body?: B;
    query?: Q;
    response: R;
    status?: number;
}): Route<B, Q, R>;
type RouteBody<T> = T extends Route<infer B, z.ZodType, z.ZodType> ? z.input<B> : never;
type RouteQuery<T> = T extends Route<z.ZodType, infer Q, z.ZodType> ? z.input<Q> : never;
export type RouteResponse<T> = T extends Route<z.ZodType, z.ZodType, infer R> ? z.output<R> : never;
export interface ClientConfig {
    baseUrl: string;
    /** Bearer token for routes that need a signed-in caller. */
    token?: string;
    fetch?: typeof fetch;
}
interface CallInput<T> {
    params?: Record<string, string>;
    body?: RouteBody<T>;
    query?: RouteQuery<T>;
}
/**
 * Calls one route and returns its parsed response. Throws CloudApiError for an error the server
 * reported, and ContractViolationError for any response outside the contract.
 */
export declare function callRoute<T extends Route>(config: ClientConfig, target: T, input?: CallInput<T>): Promise<RouteResponse<T>>;
export {};
