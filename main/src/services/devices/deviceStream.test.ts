import { describe, expect, it } from 'vitest';
import { StreamFrameRates, streamSize, LiveFrames } from './deviceStream';

/** A multipart MJPEG body as the hub sends it: a boundary, headers, then a tiny JPEG per frame. */
function part(): Uint8Array {
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02, 0xff, 0xd9];
  return new Uint8Array([...Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), ...jpeg, 0x0d, 0x0a]);
}

/** A stream the test feeds by hand, so it stays open between chunks. */
function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(opened) { controller = opened; } });
  return { body, push: (chunk: Uint8Array) => controller.enqueue(chunk), end: () => controller.close() };
}

/** Reads `count` chunks through the counter and answers how many bytes came out. */
async function read(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<number> {
  let bytes = 0;
  for (let index = 0; index < count; index++) bytes += (await reader.read()).value?.length ?? 0;
  return bytes;
}

describe('StreamFrameRates', () => {
  it('counts each frame of an open stream, including one whose start is split across chunks, and passes the bytes through', async () => {
    const one = part();
    const split = part();
    const cut = split.indexOf(0xd8); // FF | D8 FF ...
    const rates = new StreamFrameRates();
    const source = feed();
    const reader = rates.count('tab', source.body, () => 1_000).getReader();
    for (const chunk of [one, split.subarray(0, cut), split.subarray(cut), part()]) source.push(chunk);

    expect(await read(reader, 4)).toBe(one.length * 3);
    expect(rates.rate('tab', 1_500)).toBe(3);
  });

  it('counts only the last second, and forgets a stream once it ends', async () => {
    // Main reads the clock once per chunk: one frame arrives at 0 ms, the next at 2000 ms.
    const clock = [0, 2_000];
    const rates = new StreamFrameRates();
    const source = feed();
    const reader = rates.count('tab', source.body, () => clock.shift() ?? 2_000).getReader();
    source.push(part());
    source.push(part());
    await read(reader, 2);

    expect(rates.rate('tab', 2_500)).toBe(1);
    expect(rates.rate('other', 2_500)).toBeUndefined();
    source.end();
    await reader.read();
    expect(rates.rate('tab', 2_500)).toBeUndefined();
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

describe('LiveFrames', () => {
  /** A device stream the test feeds: each `send` is one JPEG-shaped frame carrying `label`. */
  function device() {
    const opened: AbortSignal[] = [];
    let push: (chunk: Uint8Array) => void = () => undefined;
    const open = async (_id: string, signal: AbortSignal) => {
      opened.push(signal);
      return new Response(new ReadableStream<Uint8Array>({ start: controller => { push = chunk => controller.enqueue(chunk); } }));
    };
    const send = (label: string) => push(Buffer.concat([Buffer.from('--frame\r\n'), Buffer.from([0xff, 0xd8]), Buffer.from(label), Buffer.from([0xff, 0xd9])]));
    return { opened, open, send };
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));

  it('answers with the newest frame from one open stream, not the first', async () => {
    const hub = device();
    const frames = new LiveFrames(hub.open, 1_000);
    const first = frames.latest('D1');
    await tick();
    hub.send('old');
    expect((await first).subarray(2, 5).toString()).toBe('old');
    hub.send('tap');
    hub.send('new');
    await tick();
    expect((await frames.latest('D1')).subarray(2, 5).toString()).toBe('new');
    expect(hub.opened).toHaveLength(1);
    frames.closeAll();
  });

  it('reads a frame whose bytes, end marker included, arrive split across chunks', async () => {
    const opened: AbortSignal[] = [];
    let push: (chunk: Uint8Array) => void = () => undefined;
    const frames = new LiveFrames(async (_id, signal) => {
      opened.push(signal);
      return new Response(new ReadableStream<Uint8Array>({ start: controller => { push = chunk => controller.enqueue(chunk); } }));
    }, 1_000);
    const first = frames.latest('D1');
    await tick();
    push(Buffer.concat([Buffer.from('--frame\r\n'), Buffer.from([0xff, 0xd8]), Buffer.from('spl')]));
    push(Buffer.concat([Buffer.from('it'), Buffer.from([0xff])]));
    push(Buffer.concat([Buffer.from([0xd9]), Buffer.from('--frame\r\n')]));
    expect((await first).toString('latin1')).toBe('\xff\xd8split\xff\xd9');
    frames.closeAll();
  });

  it('closes the stream when nobody has asked for a frame in a while, and opens a new one on the next ask', async () => {
    const hub = device();
    const frames = new LiveFrames(hub.open, 30);
    const first = frames.latest('D1');
    await tick();
    hub.send('one');
    await first;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(hub.opened[0].aborted).toBe(true);
    const next = frames.latest('D1');
    await tick();
    hub.send('two');
    expect((await next).subarray(2, 5).toString()).toBe('two');
    expect(hub.opened).toHaveLength(2);
    frames.closeAll();
  });
});
