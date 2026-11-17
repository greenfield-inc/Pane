import type { DeviceStreamInfo } from '../../../../shared/types/devices';

/** The stream's longest side, in pixels, that a tab may ask for: 320 (a small tab) to 4096 (the hub's limit). */
const MIN_STREAM_PX = 320;
const MAX_STREAM_PX = 4096;
const SETTINGS_TIMEOUT_MS = 2_000;

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
