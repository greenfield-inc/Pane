import type { DeviceStreamInfo } from '../../../../shared/types/devices';

/** The stream's longest side, in pixels, that a tab may ask for: 320 (a small tab) to 4096 (the hub's limit). */
const MIN_STREAM_PX = 320;
const MAX_STREAM_PX = 4096;
const SETTINGS_TIMEOUT_MS = 2_000;

/** A path on the hub that streams `info` (local, or a linked Mac's through its tunnel), such as `/vendor/serve-sim/logs`. */
export function hubUrl(info: DeviceStreamInfo, pathname: string): string {
  return new URL(pathname, info.streamUrl).toString();
}

/** A requested stream size as the hub accepts it, or undefined when the request names none. */
export function streamSize(value: string | null): number | undefined {
  const px = Number(value);
  if (!value || !Number.isFinite(px) || px <= 0) return undefined;
  return Math.round(Math.min(MAX_STREAM_PX, Math.max(MIN_STREAM_PX, px)));
}

/**
 * Sizes a simulator's stream to the tab showing it: the hub encodes each frame with its longest
 * side at `maxDimension` pixels instead of the device's native size, which is most of the
 * stream's cost. The hub applies it live to that device's stream.
 */
export async function sizeStream(info: DeviceStreamInfo, maxDimension: number): Promise<void> {
  const url = info.streamUrl.replace(/\/stream\.mjpeg$/, '/stream-settings');
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxDimension }),
    signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`the hub answered ${response.status}`);
}

const WINDOW_MS = 1_000;

/** Frames each tab's stream delivered over the last second, counted as the JPEGs pass through main. */
export class StreamFrameRates {
  private readonly frames = new Map<string, number[]>();

  /** `body` unchanged, with each JPEG in it counted for `panelId`. */
  count(panelId: string, body: ReadableStream<Uint8Array>, now: () => number = () => performance.now()): ReadableStream<Uint8Array> {
    const times: number[] = [];
    this.frames.set(panelId, times);
    let previous = 0;
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        const at = now();
        // A JPEG starts with FF D8 FF; one split across two chunks is checked with the byte before.
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== 0xd8) continue;
          const before = index > 0 ? chunk[index - 1] : previous;
          if (before === 0xff && (index + 1 >= chunk.length || chunk[index + 1] === 0xff)) times.push(at);
        }
        previous = chunk.length > 0 ? chunk[chunk.length - 1] : previous;
        while (times.length > 0 && times[0] < at - WINDOW_MS) times.shift();
        controller.enqueue(chunk);
      },
      flush: () => { if (this.frames.get(panelId) === times) this.frames.delete(panelId); },
    }));
  }

  /** Frames in the last second, or undefined when no stream for the tab passed through main. */
  rate(panelId: string, now: number = performance.now()): number | undefined {
    const times = this.frames.get(panelId);
    if (!times) return undefined;
    return times.filter(at => at >= now - WINDOW_MS).length;
  }
}

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
/** A frame larger than this is not a frame: the stream is broken. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface FrameReader { latest?: Buffer; first: Promise<Buffer>; controller: AbortController; idle?: NodeJS.Timeout }

/**
 * The newest frame of each device's MJPEG stream, from one connection that stays open while
 * frames are asked for and closes `keepMs` after the last ask. A new connection starts with
 * whatever frame the hub last kept, which can be a second old; a stream that stays open
 * shows a tap within a frame or two.
 */
export class LiveFrames {
  private readonly readers = new Map<string, FrameReader>();

  constructor(private readonly open: (id: string, signal: AbortSignal) => Promise<Response>, private readonly keepMs = 10_000, private readonly firstWithinMs = 10_000) {}

  /** The newest frame of `id`, waiting for the first when its stream has just opened. */
  async latest(id: string): Promise<Buffer> {
    const reader = this.readers.get(id) ?? this.start(id);
    clearTimeout(reader.idle);
    reader.idle = setTimeout(() => this.close(id, reader), this.keepMs);
    reader.idle.unref();
    return reader.latest ?? reader.first;
  }

  closeAll(): void {
    for (const [id, reader] of [...this.readers]) this.close(id, reader);
  }

  private close(id: string, reader: FrameReader): void {
    clearTimeout(reader.idle);
    reader.controller.abort();
    if (this.readers.get(id) === reader) this.readers.delete(id);
  }

  private start(id: string): FrameReader {
    const controller = new AbortController();
    let resolveFirst: (frame: Buffer) => void = () => undefined;
    let rejectFirst: (cause: Error) => void = () => undefined;
    const first = new Promise<Buffer>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    first.catch(() => undefined);
    const reader: FrameReader = { first, controller };
    this.readers.set(id, reader);
    const firstTimer = setTimeout(() => { rejectFirst(new Error(`no frame within ${this.firstWithinMs / 1000} s`)); this.close(id, reader); }, this.firstWithinMs);
    firstTimer.unref();
    void (async () => {
      const response = await this.open(id, controller.signal);
      if (!response.ok || !response.body) throw new Error(`the stream answered ${response.status}`);
      const body = response.body.getReader();
      let buffered = Buffer.alloc(0);
      for (;;) {
        const { value, done } = await body.read();
        if (done) throw new Error('the stream ended');
        buffered = Buffer.concat([buffered, Buffer.from(value)]);
        for (;;) {
          const start = buffered.indexOf(JPEG_START);
          const end = start === -1 ? -1 : buffered.indexOf(JPEG_END, start + 2);
          if (end === -1) break;
          reader.latest = Buffer.from(buffered.subarray(start, end + 2));
          clearTimeout(firstTimer);
          resolveFirst(reader.latest);
          buffered = buffered.subarray(end + 2);
        }
        if (buffered.length > MAX_FRAME_BYTES) throw new Error('the stream sent no whole frame');
      }
    })().catch((cause: unknown) => {
      clearTimeout(firstTimer);
      rejectFirst(cause instanceof Error ? cause : new Error(String(cause)));
      this.close(id, reader);
    });
    return reader;
  }
}
