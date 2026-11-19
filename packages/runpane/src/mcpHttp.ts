import { paneMcpServerFactory, runCliProcess, type PaneMcpServerOptions, type RunCli } from './mcp';
import {
  createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, originValidationResponse, type AuthInfo,
} from './mcpSdk';
import { boundary, decodeBoundary, type JsonValue } from './boundaryDecoder';
import { failureJson } from './errors';

export { failureJson, runCliProcess, type AuthInfo, type RunCli };

/** Answers one authenticated request; `auth` reaches each tool call's `runCli`. */
export type PaneMcpHttpHandler = (request: Request, auth: AuthInfo) => Promise<Response>;

/**
 * Pane's MCP server over streamable HTTP, as a fetch handler: the same tools as `runpane mcp`.
 * Serving is stateless, so a client keeps working across server restarts with no session to
 * rebuild. It answers loopback hosts only and refuses browser origins other than loopback
 * (DNS rebinding). The caller checks the bearer token first (main/src/services/paneMcpEndpoint.ts).
 * A dropped connection aborts the request, which ends the `runpane` process running the call.
 * The body is parsed here so the SDK serves a 2025-era call with this request rather than a clone:
 * a clone's signal follows the original only weakly, so once collected it never aborts.
 */
export function createPaneMcpHttpHandler(options: PaneMcpServerOptions & { onerror?: (error: Error) => void }): PaneMcpHttpHandler {
  const handler = createMcpHandler(paneMcpServerFactory(options), { onerror: options.onerror });
  return async (request, auth) => hostHeaderValidationResponse(request, localhostAllowedHostnames())
    ?? originValidationResponse(request, localhostAllowedOrigins())
    ?? handler.fetch(request, { authInfo: auth, parsedBody: request.method === 'POST' ? parseJson(await request.clone().text()) : undefined });
}

/** The body as JSON, or undefined when it isn't, so the SDK answers it with its own parse error. */
function parseJson(text: string): JsonValue | undefined {
  try {
    return decodeBoundary(JSON.parse(text), boundary.json);
  } catch {
    return undefined;
  }
}
