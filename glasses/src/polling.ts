// Keeps a computer current by reading it again and again, for hosts whose fetch can't stream a
// response (Glassly's background resolves only once the body ends, so `/events` never arrives).
// It stands in for the event stream: each read becomes the event the stream would have sent, so
// RemoteDaemonClient and HostConnection work unchanged.
import {
  RemoteAuthError,
  getRemoteAuthFailureMessage,
  isAuthFailureResponse,
  type RemoteDaemonTransport,
  type RemoteEventStreamContext,
  type RemoteFetch,
} from '../../shared/remoteClient/remoteDaemonClient';
import { createFetchEventStreamTransport } from '../../shared/remoteClient/fetchEventStreamTransport';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../shared/validation/boundaryDecoder';
import type { Cancel } from './platform';

/** How often the glasses read each computer while Pane is in front, and while it isn't. */
export const POLL_FRONT_MS = 2_000;
export const POLL_BEHIND_MS = 5_000;

/** When to read next, and a way to read at once (on wake or a touch). */
export class PollClock {
  private readonly waiting = new Set<() => void>();

  constructor(private readonly later: (fn: () => void, ms: number) => Cancel, private readonly front: () => boolean) {}

  /** Pane is in front: read the full workspace state, and read more often. */
  get inFront(): boolean {
    return this.front();
  }

  /** Resolves after the current interval, or as soon as `now()` is called. */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      let timer: Cancel | null = null;
      const done = () => {
        timer?.cancel();
        this.waiting.delete(done);
        resolve();
      };
      this.waiting.add(done);
      timer = this.later(done, this.front() ? POLL_FRONT_MS : POLL_BEHIND_MS);
    });
  }

  /** Every computer reads again now. */
  now(): void {
    for (const done of [...this.waiting]) done();
  }
}

const invokeSchema = boundary.union(
  boundary.object({ ok: boundary.literal(true), result: boundary.optional(boundary.json) }),
  boundary.object({ ok: boundary.literal(false), error: boundary.optional(boundary.object({ message: boundary.optional(boundary.string), code: boundary.optional(boundary.string) })) }),
);

const workspaceSchema = boundary.object({
  epoch: boundary.optional(boundary.string),
  generation: boundary.optional(boundary.number),
  entries: boundary.array(boundary.object({
    panelId: boundary.optional(boundary.string),
    to: boundary.optional(boundary.string),
    running: boundary.optional(boundary.boolean),
  })),
});

/** The agent status the event stream reports for a workspace entry. */
function agentState(entry: { to?: string; running?: boolean }): string {
  return entry.running === false ? 'stopped' : entry.to ?? 'idle';
}

/**
 * A transport whose "event stream" is a loop of reads. Each Notify snapshot becomes a
 * `notify:shared-changed` event; in front, each workspace state becomes `panel:agentStatus` events
 * for the panels whose status changed, and a list refresh when a panel came or went. A read that
 * fails ends the stream, so the client reconnects as it would after a dropped stream.
 */
export function createPollingTransport(fetch: RemoteFetch, clock: PollClock): RemoteDaemonTransport {
  const base = createFetchEventStreamTransport(fetch);
  return {
    invokeRequest: base.invokeRequest,

    async openEventStream(context: RemoteEventStreamContext) {
      const read = async (channel: string, args: unknown[]): Promise<JsonValue | null> => {
        const { headers, body } = base.invokeRequest(context, channel, args);
        const response = await fetch(`${context.baseUrl}/invoke`, { method: 'POST', headers, body });
        if (isAuthFailureResponse(response.status)) throw new RemoteAuthError(getRemoteAuthFailureMessage());
        const payload = decodeOptionalBoundary(await response.json(), invokeSchema);
        if (!payload) throw new Error(`Unreadable answer to ${channel} (HTTP ${response.status})`);
        if (!payload.ok) {
          // A command an older Pane doesn't know or let glasses run is no outage.
          if (response.status === 400 || response.status === 404) return null;
          throw new Error(payload.error?.message ?? `${channel} failed with ${response.status}`);
        }
        return payload.result ?? null;
      };
      const emit = (channel: string, value: JsonValue) => {
        context.onEvent({ event: 'daemon-event', data: JSON.stringify({ channel, args: [value], timestamp: new Date().toISOString() }) });
      };

      // The first read proves the computer answers; only then is the "stream" open.
      let snapshot = await read('notify:remote-snapshot', []);
      context.onOpen();
      context.onEvent({ event: 'ready', data: '{}' });
      let statuses: Map<string, string> | null = null;
      let workspaceKey = '';
      while (!context.signal.aborted) {
        if (snapshot !== null) emit('notify:shared-changed', snapshot);
        if (clock.inFront) {
          const workspace = decodeOptionalBoundary(await read('runpane:workspace:state', [{}]), workspaceSchema);
          const key = workspace ? `${workspace.epoch ?? ''}:${workspace.generation ?? ''}` : '';
          if (workspace && key !== workspaceKey) {
            workspaceKey = key;
            const next = new Map(workspace.entries.flatMap((entry) => (entry.panelId ? [[entry.panelId, agentState(entry)] as const] : [])));
            if (statuses) {
              for (const [panelId, state] of next) if (statuses.get(panelId) !== state) emit('panel:agentStatus', { panelId, state });
              const panels = (map: Map<string, string>) => [...map.keys()].sort().join(',');
              if (panels(next) !== panels(statuses)) emit('panel:created', {});
            }
            statuses = next;
          }
        }
        await clock.wait();
        if (context.signal.aborted) return;
        snapshot = await read('notify:remote-snapshot', []);
      }
    },
  };
}
