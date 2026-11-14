import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { createComputerCaller } from './relayLinks';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name));
const COMPUTER = '75rnqtlvttepjja3.relay.test';

const servers: https.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('calling a linked computer', () => {
  it('fails when the computer drops the connection partway through its answer', async () => {
    const server = https.createServer({ cert: fixture('computer.pem'), key: fixture('computer.key') }, (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      response.write('{"ok":true,');
      setTimeout(() => response.socket?.destroy(), 50);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    const { port } = server.address() as AddressInfo;
    const call = createComputerCaller({ dial: { host: '127.0.0.1', port }, extraCa: fixture('ca.pem').toString() });

    const answer = call({ id: 'relay-x', label: 'Build Box', baseUrl: `https://${COMPUTER}`, token: 'link-token', transport: 'http+sse' }, 'relay:client:computer', []);
    const settled = await Promise.race([
      answer.then(() => 'resolved', (error: Error) => error.message),
      new Promise((resolve) => { setTimeout(resolve, 3_000, 'still waiting'); }),
    ]);

    expect(settled).toBe('Build Box stopped answering partway through its reply.');
  });
});
