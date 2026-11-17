import { describe, expect, it } from 'vitest';
import { StreamFrameRates, streamSize } from './deviceStream';

/** A multipart MJPEG body as the hub sends it: a boundary, headers, then a tiny JPEG per frame. */
function part(): Uint8Array {
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02, 0xff, 0xd9];
  return new Uint8Array([...Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), ...jpeg, 0x0d, 0x0a]);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

describe('StreamFrameRates', () => {
  it('counts each frame of a stream, including one whose start is split across chunks, and passes the bytes through', async () => {
    const one = part();
    const split = part();
    const cut = split.indexOf(0xd8); // FF | D8 FF ...
    const chunks = [one, split.subarray(0, cut), split.subarray(cut), part()];
    const rates = new StreamFrameRates();
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });

    const passed = await drain(rates.count('tab', body, () => 1_000));

    expect(passed).toBe(one.length * 3);
    expect(rates.rate('tab', 1_500)).toBe(3);
  });

  it('counts only the last second, and knows nothing of a tab that never streamed', async () => {
    // Main reads the clock once per chunk: one frame arrives at 0 ms, the next at 2000 ms.
    const clock = [0, 2_000];
    const rates = new StreamFrameRates();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(part()); controller.enqueue(part()); controller.close(); } });
    await drain(rates.count('tab', body, () => clock.shift() ?? 2_000));

    expect(rates.rate('tab', 2_500)).toBe(1);
    expect(rates.rate('other', 2_500)).toBeUndefined();
  });
});

describe('streamSize', () => {
  it('keeps a requested size inside the range the hub accepts, and ignores a missing or bad one', () => {
    expect(streamSize('1280')).toBe(1280);
    expect(streamSize('40')).toBe(320);
    expect(streamSize('9000')).toBe(4096);
    expect(streamSize(null)).toBeUndefined();
    expect(streamSize('abc')).toBeUndefined();
  });
});
