import {
  SESSION_PORTS_CLOSE_CHANNEL,
  SESSION_PORTS_LIST_CHANNEL,
  SESSION_PORTS_OPEN_CHANNEL,
  decodeSessionPortsSnapshot,
  type SessionPortOpenRequest,
  type SessionPortsSnapshot,
} from '../../../shared/types/sessionPorts';
import type { JsonObject, JsonValue } from '../../../shared/validation/boundaryDecoder';

/**
 * What the Ports row needs from a host: the desktop (preload IPC to the
 * connected daemon) and the web client (HTTP+SSE) each provide one.
 */
export interface SessionPortsTransport {
  invoke(channel: string, args: JsonValue[]): Promise<JsonValue | undefined>;
  /** `runpane:ports:changed` from the daemon; the payload may carry the new list. */
  onChanged(listener: (payload: JsonValue | undefined) => void): () => void;
  /** The same host asks for a re-read (its connection was re-established or resynced). */
  onReconnected(listener: () => void): () => void;
  /**
   * Which host `invoke` reaches: a key per connected host, null while disconnected. Reports the current
   * host once it is known, then every change.
   */
  watchHost(listener: (host: string | null) => void): () => void;
}

export type SessionPortsState =
  /** No list for the connected host yet, or no host connected. */
  | { status: 'loading' }
  /** `host` is the transport's key for the host the list came from; actions on it must name it. */
  | { status: 'ready'; host: string; snapshot: SessionPortsSnapshot }
  /** The daemon has no ports channels (older build or no cloud Session): hide the row. */
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export interface SessionPortsSync {
  refresh(): Promise<void>;
  /** Refused without sending when `host` is no longer the connected host. */
  open(host: string, request: SessionPortOpenRequest): Promise<void>;
  /** Refused without sending when `host` is no longer the connected host. */
  close(host: string, target: number | string): Promise<void>;
  dispose(): void;
}

interface SessionPortsSyncOptions {
  /** Backstop poll while mounted; events and reconnects do the real work. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 30_000;
const UNSUPPORTED_ERROR = /No Pane daemon command registered|not daemon-owned|unknown (channel|command)/i;

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The daemon refused to replace an existing tailnet serve entry without confirmation. */
export function isSessionPortConflict(cause: unknown): boolean {
  // Not ERR_PORTS_IN_USE (another published port): yes cannot fix that one.
  return /ERR_PORTS_CONFLICT|--yes|already served/i.test(errorMessage(cause));
}

function isFailedIpcResponse<Value>(value: Value): string | null {
  if (value instanceof Object && 'success' in value && value.success === false) {
    return 'error' in value && value.error ? String(value.error) : 'Request failed';
  }
  return null;
}

async function invokeChecked(transport: SessionPortsTransport, channel: string, args: JsonValue[]): Promise<JsonValue | undefined> {
  const result = await transport.invoke(channel, args);
  const failure = isFailedIpcResponse(result);
  if (failure !== null) throw new Error(failure);
  return result;
}

const HOST_CHANGED_MESSAGE = 'The connection changed: this port belongs to a host Pane is no longer connected to.';

/**
 * Keeps the connected daemon's Session ports current: a baseline read, then a
 * re-read on every change event, reconnect and backstop tick. Only the newest
 * read for the connected host may publish, so a slow response never overwrites
 * a newer change, and nothing from a previous host (a read, an event or an
 * action's follow-up) lands after the connection switched.
 */
export function createSessionPortsSync(
  transport: SessionPortsTransport,
  onState: (state: SessionPortsState) => void,
  options: SessionPortsSyncOptions = {},
): SessionPortsSync {
  let disposed = false;
  let generation = 0;
  let unsupported = false;
  // undefined until the transport reports one; null while disconnected.
  let host: string | null | undefined;
  // The tailnet name in the connected host's last list: a pushed list must name the same one.
  let readHost: { name: string | undefined } | null = null;

  const publish = (state: SessionPortsState) => {
    if (!disposed) onState(state);
  };

  const refresh = async () => {
    if (!host) return;
    const current = ++generation;
    const readFrom = host;
    try {
      const result = await invokeChecked(transport, SESSION_PORTS_LIST_CHANNEL, []);
      if (disposed || current !== generation) return;
      const snapshot = decodeSessionPortsSnapshot(result);
      unsupported = false;
      readHost = snapshot ? { name: snapshot.host } : null;
      publish(snapshot ? { status: 'ready', host: readFrom, snapshot } : { status: 'error', message: 'Unexpected ports list from the daemon' });
    } catch (error) {
      if (disposed || current !== generation) return;
      unsupported = UNSUPPORTED_ERROR.test(errorMessage(error));
      publish(unsupported ? { status: 'unsupported' } : { status: 'error', message: errorMessage(error) });
    }
  };

  // Invalidates everything read from the previous host at once, before any new read.
  const switchHost = (next: string | null) => {
    host = next;
    generation += 1;
    readHost = null;
    unsupported = false;
    publish({ status: 'loading' });
    void refresh();
  };

  const requireHost = (expected: string) => {
    if (disposed || host !== expected) throw new Error(HOST_CHANGED_MESSAGE);
  };

  const unsubscribeChanged = transport.onChanged(payload => {
    if (!host) return;
    const snapshot = decodeSessionPortsSnapshot(payload);
    // Apply a pushed list only when it names the host this connection last read; otherwise ask.
    if (snapshot && readHost && snapshot.host === readHost.name) {
      // A pushed list is the newest truth: supersede any read in flight.
      generation += 1;
      unsupported = false;
      publish({ status: 'ready', host, snapshot });
      return;
    }
    void refresh();
  });
  const unsubscribeReconnected = transport.onReconnected(() => { void refresh(); });
  publish({ status: 'loading' });
  const unsubscribeHost = transport.watchHost(next => {
    if (next !== host) switchHost(next);
  });
  const timer = setInterval(() => {
    if (!unsupported) void refresh();
  }, options.pollMs ?? DEFAULT_POLL_MS);

  return {
    refresh,
    async open(expectedHost, request) {
      requireHost(expectedHost);
      const args: JsonObject = { port: request.port };
      if (request.name !== undefined) args.name = request.name;
      if (request.httpsPort !== undefined) args.httpsPort = request.httpsPort;
      if (request.yes === true) args.yes = true;
      await invokeChecked(transport, SESSION_PORTS_OPEN_CHANNEL, [args]);
      if (host === expectedHost) await refresh();
    },
    async close(expectedHost, target) {
      requireHost(expectedHost);
      await invokeChecked(transport, SESSION_PORTS_CLOSE_CHANNEL, [{ target }]);
      if (host === expectedHost) await refresh();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      unsubscribeChanged();
      unsubscribeReconnected();
      unsubscribeHost();
    },
  };
}
