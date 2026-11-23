import http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../../types/config';
import type { ConfigManager } from '../configManager';
import { resolvePeer } from './peer';

const invokeSchema = boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) });

function urlOf(listening: http.Server): string {
  return `http://127.0.0.1:${decodeBoundary(listening.address(), boundary.object({ port: boundary.number })).port}`;
}

/** A saved computer's Pane, as a local HTTP server answering `/invoke` the way a host does. */
let server: http.Server;
let calls: Array<{ authorization?: string; channel: string; args: unknown[] }>;
let answer: (channel: string) => { status: number; body: object };

beforeEach(async () => {
  calls = [];
  answer = () => ({ status: 200, body: { ok: true, result: { stage: 'built' } } });
  server = http.createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      const body = decodeBoundary(JSON.parse(text), invokeSchema);
      calls.push({ authorization: request.headers.authorization, channel: body.channel, args: body.args });
      const reply = answer(body.channel);
      response.writeHead(reply.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
});

function configWith(baseUrl: string): Pick<ConfigManager, 'getConfig'> {
  const computers = [{
    id: 'studio', label: 'Studio',
    routes: [{ id: `public:${baseUrl}`, kind: 'public', source: 'link', baseUrl, token: 'link-token' }],
  }];
  const remoteDaemon = normalizeRemoteDaemonConfig({ client: { mode: 'local', computers } });
  // SAFETY: peers read only `remoteDaemon` from the config.
  return { getConfig: () => ({ remoteDaemon }) as AppConfig };
}

const statusSchema = boundary.object({ stage: boundary.string });

describe('resolvePeer for a saved computer', () => {
  it('calls the computer over its saved route with its token', async () => {
    const url = urlOf(server);
    const peer = resolvePeer('Studio', configWith(url), 'studio');
    await expect(peer.invoke('runpane:move:status', [{ moveId: 'm1' }], statusSchema, 5_000)).resolves.toEqual({ stage: 'built' });
    expect(calls).toEqual([{ authorization: 'Bearer link-token', channel: 'runpane:move:status', args: [{ moveId: 'm1' }] }]);
  });

  it('says the target is too old when its Pane lacks the move channels', async () => {
    answer = () => ({ status: 404, body: { ok: false, error: { message: 'Unknown channel', code: 'ERR_UNKNOWN_CHANNEL' } } });
    const peer = resolvePeer('Studio', configWith(urlOf(server)), 'studio');
    await expect(peer.invoke('runpane:move:preflight', [{}], statusSchema, 5_000)).rejects.toMatchObject({ code: 'ERR_MOVE_TARGET_OUTDATED' });
  });

  it('passes on the target\'s own refusal with its code and next step', async () => {
    answer = () => ({ status: 500, body: { ok: false, error: { message: 'Disk full', code: 'ERR_MOVE_DISK', next: 'Free space on Studio.' } } });
    const peer = resolvePeer('Studio', configWith(urlOf(server)), 'studio');
    await expect(peer.invoke('runpane:move:write', [{}], statusSchema, 5_000)).rejects.toMatchObject({ code: 'ERR_MOVE_DISK', next: 'Free space on Studio.' });
  });

  it('is unreachable, not a target answer, when nothing listens', async () => {
    const url = urlOf(server);
    await new Promise(resolve => server.close(resolve));
    server = http.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const peer = resolvePeer('Studio', configWith(url), 'studio');
    await expect(peer.invoke('runpane:move:status', [{}], statusSchema, 5_000)).rejects.toMatchObject({ code: 'ERR_MOVE_UNREACHABLE' });
  });

  it('names a computer no longer saved', async () => {
    const peer = resolvePeer('Studio', configWith('http://127.0.0.1:9'), 'gone');
    await expect(peer.invoke('runpane:move:status', [{}], statusSchema, 5_000)).rejects.toMatchObject({ code: 'ERR_MOVE_UNKNOWN_COMPUTER' });
  });
});
