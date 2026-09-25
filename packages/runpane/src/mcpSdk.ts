// The build bundles this module with esbuild (scripts/bundle-mcp-sdk.js) so the
// published package and the copy shipped inside Pane need no runtime dependencies.
export { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
export { serveStdio } from '@modelcontextprotocol/server/stdio';
