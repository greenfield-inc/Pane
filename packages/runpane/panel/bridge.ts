// The MCP Apps view side of the host channel (JSON-RPC over postMessage), written by hand
// because the panel needs only the handshake, tool calls, and model context.
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject, type JsonValue } from '../src/boundaryDecoder';

const hostContextSchema = boundary.object({
  theme: boundary.optional(boundary.enumeration('light', 'dark')),
  displayMode: boundary.optional(boundary.enumeration('inline', 'fullscreen', 'pip')),
  styles: boundary.optional(boundary.object({ variables: boundary.optional(boundary.jsonObject) })),
});
export type HostContext = ReturnType<typeof hostContextSchema.decode>;

const toolResultSchema = boundary.object({
  content: boundary.optional(boundary.array(boundary.object({ type: boundary.string, text: boundary.optional(boundary.string) }))),
  structuredContent: boundary.optional(boundary.jsonObject),
  isError: boundary.optional(boundary.boolean),
});
export type ToolResult = ReturnType<typeof toolResultSchema.decode>;

const messageSchema = boundary.object({
  jsonrpc: boundary.literal('2.0'),
  id: boundary.optional(boundary.union(boundary.number, boundary.string)),
  method: boundary.optional(boundary.string),
  params: boundary.optional(boundary.jsonObject),
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.object({ message: boundary.string })),
});
type Message = ReturnType<typeof messageSchema.decode>;

const PROTOCOL_VERSION = '2026-01-26';
const pending = new Map<number | string, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, (params: JsonObject) => void>();
let nextId = 1;

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  let message: Message;
  try {
    message = decodeBoundary(event.data, messageSchema);
  } catch {
    return;
  }
  if (message.method) {
    if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, result: {} });
    listeners.get(message.method)?.(message.params ?? {});
    return;
  }
  const waiter = message.id === undefined ? undefined : pending.get(message.id);
  if (!waiter || message.id === undefined) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result ?? null);
});

function post(message: JsonObject): void {
  window.parent.postMessage(message, '*');
}

function request<Result>(method: string, params: JsonObject, schema: BoundarySchema<Result>): Promise<Result> {
  const id = nextId++;
  return new Promise<Result>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => {
        try {
          resolve(decodeBoundary(value, schema));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      reject,
    });
    post({ jsonrpc: '2.0', id, method, params });
  });
}

export function onToolResult(listener: (result: ToolResult) => void): void {
  listeners.set('ui/notifications/tool-result', (params) => listener(decodeBoundary(params, toolResultSchema)));
}

export function onHostContextChanged(listener: (context: HostContext) => void): void {
  listeners.set('ui/notifications/host-context-changed', (params) => listener(decodeBoundary(params, hostContextSchema)));
}

export async function connect(): Promise<HostContext> {
  const { hostContext } = await request('ui/initialize', {
    protocolVersion: PROTOCOL_VERSION,
    appInfo: { name: 'pane-agents-panel', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
  }, boundary.object({ hostContext: boundary.optional(hostContextSchema) }));
  post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
  const observer = new ResizeObserver(() => {
    const { width, height } = document.documentElement.getBoundingClientRect();
    post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: Math.ceil(width), height: Math.ceil(height) } });
  });
  observer.observe(document.documentElement);
  return hostContext ?? { theme: undefined, displayMode: undefined, styles: undefined };
}

export function callTool(name: string, args: JsonObject): Promise<ToolResult> {
  return request('tools/call', { name, arguments: args }, toolResultSchema);
}

/** Asks the host to open a link, such as a pull request, in the browser. */
export async function openLink(url: string): Promise<void> {
  await request('ui/open-link', { url }, boundary.json);
}

/** Tells the model what the panel shows. Each call replaces the previous context. */
export async function updateModelContext(text: string): Promise<void> {
  await request('ui/update-model-context', {
    content: [{ type: 'text', text, _meta: { 'openai/title': 'Pane agents' } }],
  }, boundary.json);
}
