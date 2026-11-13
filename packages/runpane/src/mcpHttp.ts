import { paneMcpServerFactory, runCliProcess, type PaneMcpServerOptions, type RunCli } from './mcp';
import {
  createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, originValidationResponse, type AuthInfo,
} from './mcpSdk';
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
 */
export function createPaneMcpHttpHandler(options: PaneMcpServerOptions & { onerror?: (error: Error) => void }): PaneMcpHttpHandler {
  const handler = createMcpHandler(paneMcpServerFactory(options), { onerror: options.onerror });
  return async (request, auth) => hostHeaderValidationResponse(request, localhostAllowedHostnames())
    ?? originValidationResponse(request, localhostAllowedOrigins())
    ?? handler.fetch(request, { authInfo: auth });
}
