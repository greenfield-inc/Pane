// The build bundles this module with esbuild (scripts/bundle-dependencies.js) so the
// published package and the copy shipped inside Pane need no runtime dependencies.
export {
  createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, originValidationResponse,
  ProtocolError, ProtocolErrorCode, Server, type AuthInfo, type McpRequestContext,
} from '@modelcontextprotocol/server';
export { serveStdio } from '@modelcontextprotocol/server/stdio';
