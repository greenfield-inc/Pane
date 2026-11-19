import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { DeviceInputSockets, inputMessages } from './deviceInput';

/** Each message as the hub reads it: its leading byte, then its JSON body. */
function decoded(messages: Buffer[]): { byte: number; body?: unknown }[] {
  return messages.map(message => (message.length === 1 ? { byte: message[0] } : { byte: message[0], body: JSON.parse(message.subarray(1).toString()) }));
}

// Bytes and bodies from serve-sim's input socket (vendor/serve-sim handleHidMessage): 6 key, 7 rotate, 11 scroll, 16 posture.
describe('inputMessages for a simulator', () => {
  it('turns the device with byte 7 and the hub orientation name', () => {
    expect(decoded(inputMessages({ kind: 'rotate', orientation: 'landscape_left' }, 'ios'))).toEqual([{ byte: 7, body: { orientation: 'landscape_left' } }]);
  });

  it('folds half open as the laptop pose, with a request id', () => {
    const [message] = decoded(inputMessages({ kind: 'fold', posture: 'half' }, 'ios'));
    expect(message).toMatchObject({ byte: 16, body: { command: { control: 'pose', value: 'laptop' } } });
  });

  it('types a capital letter with Shift held around its key, naming the character for the hub', () => {
    expect(decoded(inputMessages({ kind: 'key', key: 'A' }, 'ios'))).toEqual([
      { byte: 6, body: { type: 'down', usage: 225 } },
      { byte: 6, body: { type: 'down', usage: 4, shifted: true, key: 'A' } },
      { byte: 6, body: { type: 'up', usage: 4, shifted: true, key: 'A' } },
      { byte: 6, body: { type: 'up', usage: 225 } },
    ]);
  });

  it('types Enter and a shifted symbol by their US keyboard usages, and ignores keys a phone has no use for', () => {
    expect(decoded(inputMessages({ kind: 'key', key: 'Enter' }, 'ios'))).toEqual([
      { byte: 6, body: { type: 'down', usage: 40, shifted: false } },
      { byte: 6, body: { type: 'up', usage: 40, shifted: false } },
    ]);
    expect(decoded(inputMessages({ kind: 'key', key: '?' }, 'ios'))[1]).toEqual({ byte: 6, body: { type: 'down', usage: 56, shifted: true, key: '?' } });
    expect(inputMessages({ kind: 'key', key: 'F5' }, 'ios')).toEqual([]);
  });

  it('scrolls at a point by fractions of the screen', () => {
    expect(decoded(inputMessages({ kind: 'scroll', x: 0.5, y: 0.4, dx: 0, dy: 0.1 }, 'ios'))).toEqual([{ byte: 11, body: { x: 0.5, y: 0.4, dx: 0, dy: 0.1 } }]);
  });
});

describe('DeviceInputSockets', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(resolve); })));
  });

  /** A hub input socket that admits with byte 131; `refuse` connections are dropped before admitting. */
  async function hub(refuse: number) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    const received: string[] = [];
    let connections = 0;
    server.on('connection', (socket: WebSocket) => {
      connections += 1;
      if (connections <= refuse) {
        socket.terminate();
        return;
      }
      socket.on('message', (data: Buffer) => received.push(data.length === 1 ? `byte ${data[0]}` : data.subarray(1).toString()));
      socket.send(Buffer.from([131]));
    });
    // SAFETY: a WebSocketServer listening on a TCP port reports an AddressInfo, never a pipe name.
    const port = (server.address() as AddressInfo).port;
    return { received, connections: () => connections, info: async () => ({ streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`, inputUrl: `ws://127.0.0.1:${port}/ws`, token: 't' }) };
  }

  it('delivers a tap queued before the hub admitted it, in order, when the first socket drops', async () => {
    const { received, connections, info } = await hub(1);
    const sockets = new DeviceInputSockets();
    sockets.send('D1', inputMessages({ kind: 'touch', phase: 'begin', x: 0.5, y: 0.5 }, 'ios'), info);
    sockets.send('D1', inputMessages({ kind: 'touch', phase: 'end', x: 0.5, y: 0.5 }, 'ios'), info);
    await expect.poll(() => received.length, { timeout: 5_000 }).toBe(3);
    expect(received).toEqual(['{"type":"begin","x":0.5,"y":0.5}', '{"type":"end","x":0.5,"y":0.5}', 'byte 17']);
    expect(connections()).toBe(2);
    sockets.closeAll();
  }, 10_000);
});
