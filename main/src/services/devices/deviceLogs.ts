import type { DeviceLogLine, DeviceLogPage, DeviceStreamInfo } from '../../../../shared/types/devices';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { hubUrl } from './deviceStream';

const PAGE_LIMIT = 500;
const ANDROID_BUFFER = 2_000;
/** An emulator's log relay stops when no tab has read it for this long. */
const ANDROID_IDLE_MS = 20_000;
/** A failed relay keeps saying why this long before the next read starts another. */
const RELAY_RETRY_MS = 5_000;

const simPageSchema = boundary.object({
  latestSeq: boundary.optional(boundary.number),
  streamError: boundary.optional(boundary.nullable(boundary.string)),
  lines: boundary.array(boundary.object({ seq: boundary.number, at: boundary.optional(boundary.string), raw: boundary.string })),
});
/** One `log stream --style ndjson` event: only the fields the tab shows. */
const simEventSchema = boundary.object({
  timestamp: boundary.optional(boundary.string),
  messageType: boundary.optional(boundary.string),
  processImagePath: boundary.optional(boundary.string),
  category: boundary.optional(boundary.string),
  eventMessage: boundary.optional(boundary.string),
});
const emuBatchSchema = boundary.object({ lines: boundary.array(boundary.object({ line: boundary.string, at: boundary.optional(boundary.string) })) });

function simLevel(messageType: string | undefined): DeviceLogLine['level'] {
  const type = messageType?.toLowerCase();
  return type === 'error' || type === 'fault' ? 'error' : type === 'debug' ? 'debug' : type === 'info' || type === 'default' || type === undefined ? 'info' : 'warning';
}

/** A simulator's log line, from the hub's ndjson envelope. */
function simLogLine(seq: number, raw: string, fallbackAt: string | undefined): DeviceLogLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const event = decodeOptionalBoundary(parsed, simEventSchema);
  if (!event?.eventMessage) return undefined;
  const at = Date.parse(event.timestamp?.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2') ?? fallbackAt ?? '');
  const source = event.processImagePath?.split('/').pop() ?? event.category ?? '';
  return { seq, at: Number.isFinite(at) ? at : Date.now(), level: simLevel(event.messageType), source, message: event.eventMessage };
}

const THREADTIME = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+\s+([VDIWEFA])\s+(.*?)\s*:\s(.*)$/;

/** An emulator's logcat line in threadtime format ("11-16 22:40:01.123  1234  1250 I Tag: message"). */
function emuLogLine(seq: number, line: string, at: string | undefined): DeviceLogLine {
  const match = THREADTIME.exec(line);
  const when = Date.parse(at ?? '');
  const time = Number.isFinite(when) ? when : Date.now();
  if (!match) return { seq, at: time, level: 'info', source: '', message: line };
  const priority = match[1];
  const level: DeviceLogLine['level'] = priority === 'E' || priority === 'F' || priority === 'A' ? 'error' : priority === 'W' ? 'warning' : priority === 'I' ? 'info' : 'debug';
  return { seq, at: time, level, source: match[2], message: match[3] };
}


/**
 * A simulator's app log after `since`, from the hub, which keeps its own buffer of
 * `log stream` for the device. Only apps the person installed log here, not the system.
 */
export async function simulatorLogs(info: DeviceStreamInfo, udid: string, since: number): Promise<DeviceLogPage> {
  const url = `${hubUrl(info, '/vendor/serve-sim/logs')}?device=${encodeURIComponent(udid)}&scope=user-apps&snapshot=1&envelope=1&since=${since}&limit=${PAGE_LIMIT}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${info.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return { lines: [], next: since, problem: `The device hub answered ${response.status} for the log.` };
  const page = decodeOptionalBoundary(await response.json(), simPageSchema);
  if (!page) return { lines: [], next: since, problem: 'The device hub sent a log Pane could not read.' };
  const lines = page.lines.flatMap(entry => simLogLine(entry.seq, entry.raw, entry.at) ?? []);
  const next = Math.max(since, page.latestSeq ?? 0, ...page.lines.map(entry => entry.seq));
  const result: DeviceLogPage = { lines, next };
  if (page.streamError) result.problem = page.streamError;
  return result;
}

interface EmulatorRelay { lines: DeviceLogLine[]; seq: number; controller: AbortController; lastRead: number; problem?: string }

/**
 * Emulators' logcat, relayed from the hub's event stream into a buffer per emulator while a tab
 * reads it, since the hub keeps none for later reads.
 */
export class EmulatorLogs {
  private readonly relays = new Map<string, EmulatorRelay>();

  page(serial: string, since: number, open: (signal: AbortSignal) => Promise<Response>): DeviceLogPage {
    let relay = this.relays.get(serial);
    if (!relay) relay = this.start(serial, open);
    relay.lastRead = Date.now();
    const lines = relay.lines.filter(line => line.seq > since);
    const page: DeviceLogPage = { lines, next: Math.max(since, relay.seq) };
    if (relay.problem) page.problem = relay.problem;
    return page;
  }

  stopAll(): void {
    for (const relay of this.relays.values()) relay.controller.abort();
    this.relays.clear();
  }

  private start(serial: string, open: (signal: AbortSignal) => Promise<Response>): EmulatorRelay {
    // Sequence numbers start from the clock, so a restarted relay always counts past the last one.
    const relay: EmulatorRelay = { lines: [], seq: Date.now() * 1000, controller: new AbortController(), lastRead: Date.now() };
    const end = () => { if (this.relays.get(serial) === relay) this.relays.delete(serial); };
    this.relays.set(serial, relay);
    const idle = setInterval(() => {
      if (Date.now() - relay.lastRead < ANDROID_IDLE_MS) return;
      clearInterval(idle);
      relay.controller.abort();
      end();
    }, 5_000);
    idle.unref();
    void (async () => {
      const response = await open(relay.controller.signal);
      if (!response.ok || !response.body) throw new Error(`the hub answered ${response.status}`);
      const decoder = new TextDecoder();
      let buffered = '';
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const events = buffered.split('\n\n');
        buffered = events.pop() ?? '';
        for (const event of events) this.accept(relay, event);
      }
      throw new Error('the log stream ended');
    })().catch((cause: unknown) => {
      clearInterval(idle);
      if (relay.controller.signal.aborted) return end();
      // The view shows why for a few seconds, then the next read starts a new relay.
      relay.problem = `The emulator's log stopped: ${cause instanceof Error ? cause.message : String(cause)}. Pane will read it again.`;
      setTimeout(end, RELAY_RETRY_MS).unref();
    });
    return relay;
  }

  /** One server-sent event: `logs` carries a batch of lines. */
  private accept(relay: EmulatorRelay, event: string): void {
    const name = /^event: ?(.*)$/m.exec(event)?.[1];
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (name !== 'logs' || !data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const batch = decodeOptionalBoundary(parsed, emuBatchSchema);
    for (const entry of batch?.lines ?? []) relay.lines.push(emuLogLine(++relay.seq, entry.line, entry.at));
    if (relay.lines.length > ANDROID_BUFFER) relay.lines.splice(0, relay.lines.length - ANDROID_BUFFER);
  }
}
