import { createHash, timingSafeEqual } from 'crypto';
import { once } from 'events';
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** The native TUI's own connection supplies its resume acknowledgement. A
 * separate host thread/read cannot certify another client's attachment. */
export class CodexNativeConnection {
  private server?: WebSocketServer;
  private native?: WebSocket;
  private upstream?: WebSocket;
  private nativeId?: string;
  private closing = false;
  private readonly pending = new Set<string>();

  constructor(private readonly token: string, private readonly connect: () => Promise<WebSocket>, private readonly changed?: (id?: string) => void) {}

  async start(): Promise<string> {
    const digest = createHash('sha256').update(`Bearer ${this.token}`).digest();
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: ({ req }: { req: IncomingMessage }) =>
      timingSafeEqual(digest, createHash('sha256').update(req.headers.authorization ?? '').digest()) && !this.native,
    });
    this.server.on('connection', native => { void this.attach(native); });
    await once(this.server, 'listening');
    const { port } = decodeBoundary(this.server.address(), boundary.object({ port: boundary.number }));
    return `ws://127.0.0.1:${port}`;
  }

  confirms(id: string): boolean { return this.native?.readyState === WebSocket.OPEN && this.nativeId === id; }

  private observe(data: RawData, response: boolean): void {
    try {
      const message = decodeBoundary(JSON.parse(data.toString()), boundary.jsonObject);
      const id = decodeOptionalBoundary(message.id, boundary.union(boundary.string, boundary.number));
      if (id === undefined) return;
      const key = JSON.stringify(id);
      if (!response) {
        if (['thread/resume', 'thread/start', 'thread/fork'].includes(String(message.method))) { this.pending.add(key); this.nativeId = undefined; }
        return;
      }
      if (!this.pending.delete(key) || message.error) return;
      const result = decodeOptionalBoundary(message.result, boundary.jsonObject);
      const thread = result && decodeOptionalBoundary(result.thread, boundary.jsonObject);
      const nativeId = thread && decodeOptionalBoundary(thread.id, boundary.string);
      if (nativeId) { this.nativeId = nativeId; this.changed?.(nativeId); }
    } catch { /* Forward untouched; the native protocol owns malformed input. */ }
  }

  private async attach(native: WebSocket): Promise<void> {
    this.native = native;
    const queued: Array<{ data: RawData; binary: boolean }> = [];
    let buffered = 0;
    native.on('message', (data, binary) => {
      this.observe(data, false);
      if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(data, { binary });
      else {
        buffered += Buffer.byteLength(data.toString());
        if (buffered > 1024 * 1024) { native.close(1009); return; }
        queued.push({ data, binary });
      }
    });
    native.on('error', () => native.terminate());
    native.on('close', () => {
      this.upstream?.close(); this.upstream = undefined; this.native = undefined;
      this.nativeId = undefined; this.pending.clear();
      if (!this.closing) this.changed?.();
    });
    try {
      const upstream = await this.connect();
      if (native.readyState !== WebSocket.OPEN || this.closing) { upstream.close(); return; }
      this.upstream = upstream;
      upstream.on('message', (data, binary) => { this.observe(data, true); if (native.readyState === WebSocket.OPEN) native.send(data, { binary }); });
      upstream.on('error', () => native.close(1011));
      upstream.on('close', () => native.close());
      for (const message of queued) upstream.send(message.data, { binary: message.binary });
    } catch { native.close(1011, 'Native connection could not reach its recorded provider'); }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.native?.terminate(); this.upstream?.terminate();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.nativeId = undefined;
  }
}
