import { describe, expect, it } from 'vitest';
import { PaneSseParser } from './sseParser';
import { PaneSseParser as TextSseParser } from '../../../../shared/sseParser';

describe.each([
  ['decoded browser text', () => new TextSseParser()],
  ['Node transport', () => new PaneSseParser()],
] as const)('PaneSseParser (%s)', (_transport, createParser) => {
  it('buffers partial chunks until an event boundary arrives', () => {
    const parser = createParser();

    expect(parser.push('event: daemon-event\ndata: {"channel"')).toEqual([]);
    expect(parser.push(':"session:updated"}\n\n')).toEqual([{
      event: 'daemon-event',
      data: '{"channel":"session:updated"}',
    }]);
  });

  it('ignores comments and blank events', () => {
    const parser = createParser();

    expect(parser.push(': keep-alive\n\n')).toEqual([]);
    expect(parser.push('event: ready\n\n')).toEqual([]);
  });

  it.each(['\n', '\r\n', '\r'])('accepts every chunk split with %j line endings', (newline) => {
    const stream = ['\uFEFF: comment', 'event: heartbeat', 'data: one', 'data:  two', '', 'data', '', ''].join(newline);
    for (let split = 0; split <= stream.length; split += 1) {
      const parser = createParser();
      expect([
        ...parser.push(stream.slice(0, split)),
        ...parser.push(stream.slice(split)),
      ]).toEqual([
        { event: 'heartbeat', data: 'one\n two' },
        { event: 'message', data: '' },
      ]);
    }
  });

  it('discards incomplete events on reset before reconnecting', () => {
    const parser = createParser();
    expect(parser.push('event: stale\ndata: old\r')).toEqual([]);
    parser.reset();
    expect(parser.push('\uFEFFdata: fresh\n\n')).toEqual([{ event: 'message', data: 'fresh' }]);
  });
});

it('preserves UTF-8 characters split across Node buffer boundaries', () => {
  const parser = new PaneSseParser();
  const message = 'hello 🙂';
  const encoded = Buffer.from(`event: ready\ndata: ${message}\n\n`, 'utf8');
  const splitIndex = encoded.indexOf(Buffer.from('🙂')) + 2;

  expect(parser.push(encoded.subarray(0, splitIndex))).toEqual([]);
  expect(parser.push(encoded.subarray(splitIndex))).toEqual([{
    event: 'ready',
    data: message,
  }]);
});
