import { type Server } from 'node:http';
import { z } from 'zod';
import type { Route, RouteResponse } from '../http';
interface HandlerInput<T> {
    params: Record<string, string>;
    body: T extends Route<infer B, z.ZodType, z.ZodType> ? z.output<B> : never;
    query: T extends Route<z.ZodType, infer Q, z.ZodType> ? z.output<Q> : never;
    /** The bearer token, or null when the request carried none. */
    token: string | null;
}
type Handler<T> = (input: HandlerInput<T>) => RouteResponse<T> | Promise<RouteResponse<T>>;
export interface BoundRoute {
    route: Route;
    handle: Handler<Route>;
}
export declare function bind<T extends Route>(target: T, handle: Handler<T>): BoundRoute;
/**
 * An HTTP server for a list of bound routes. It checks each request against its route's schemas and
 * each handler's answer against the route's response schema, so a stub cannot drift from the contract.
 */
export declare function createRouteServer(routes: BoundRoute[]): Server;
export interface RunningStub {
    url: string;
    close(): Promise<void>;
}
export declare function listen(server: Server): Promise<RunningStub>;
export {};
