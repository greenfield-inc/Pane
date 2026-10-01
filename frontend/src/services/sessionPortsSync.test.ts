import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeSessionPortsSnapshot } from '../../../shared/types/sessionPorts';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { createSessionPortsSync, isSessionPortConflict, type SessionPortsState, type SessionPortsTransport } from './sessionPortsSync';

const at = '2026-09-30T23:00:00Z';
const base = { scheme: 'https', path: '/', createdAt: at, status: 'serving' };
const taste = { ...base, name: 'taste', port: 8787, httpsPort: 8787, url: 'https://rp-a.tail.ts.net:8787/', source: 'manifest' };
const pages = { ...base, name: 'pages', port: 8788, httpsPort: 8788, url: 'https://rp-a.tail.ts.net:8788/', source: 'user' };
const vite = { port: 5173, address: '127.0.0.1', process: 'vite', detectedAt: at };
// The daemon's PortsListResult (runpane:ports:list).
const list = (ports: JsonValue[], suggested: JsonValue[] = []) => ({
  ok: true, available: true, host: 'rp-a', scheme: 'https', autoOpen: false, ports, suggested, manifests: [],
});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('decodeSessionPortsSnapshot', () => {
  it('accepts the list result and the IPC envelope, sorted by HTTPS port', () => {
    const bare = decodeSessionPortsSnapshot(list([pages, taste], [vite]));
    expect(bare?.ports.map(port => port.name)).toEqual(['taste', 'pages']);
    expect(bare?.suggested).toEqual([vite]);
    expect(bare).toMatchObject({ available: true, host: 'rp-a' });
    expect(decodeSessionPortsSnapshot({ success: true, data: list([taste]) })?.ports).toHaveLength(1);
  });

  it('drops malformed entries, non-http URLs and suggestions that are already published', () => {
    const snapshot = decodeSessionPortsSnapshot(list(
      [taste, { ...pages, url: 'javascript:alert(1)' }, { ...pages, port: 0 }, { ...pages, status: 'weird' }, 'junk'],
      [{ ...vite, port: 8787 }, { port: 3000, address: '0.0.0.0', detectedAt: at, extra: true }, { ...vite, port: 'nope' }],
    ));
    expect(snapshot?.ports.map(port => port.name)).toEqual(['taste']);
    expect(snapshot?.suggested).toEqual([{ port: 3000, address: '0.0.0.0', detectedAt: at }]);
  });

  it('keeps status, detail and scheme, and reports an unavailable daemon', () => {
    const snapshot = decodeSessionPortsSnapshot({
      ...list([{ ...taste, scheme: 'http', status: 'missing', detail: 'serve entry lost' }]),
      available: false, unavailableReason: 'no tailscaled',
    });
    expect(snapshot).toMatchObject({ available: false, unavailableReason: 'no tailscaled' });
    expect(snapshot?.ports[0]).toMatchObject({ status: 'missing', detail: 'serve entry lost', scheme: 'http' });
  });

  it('rejects values that are not a list result', () => {
    expect(decodeSessionPortsSnapshot(null)).toBeNull();
    expect(decodeSessionPortsSnapshot({ ports: [] })).toBeNull();
    expect(decodeSessionPortsSnapshot({ success: false, error: 'x' })).toBeNull();
  });
});

describe('createSessionPortsSync', () => {
  let replies: Array<{ channel: string; args: JsonValue[]; resolve: (value: JsonValue) => void; reject: (error: Error) => void }>;
  let changed: (payload: JsonValue | undefined) => void;
  let reconnected: () => void;
  let states: SessionPortsState[];
  let transport: SessionPortsTransport;
  const unsubscribed: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    replies = [];
    states = [];
    unsubscribed.length = 0;
    transport = {
      invoke: (channel, args) => new Promise((resolve, reject) => { replies.push({ channel, args, resolve, reject }); }),
      onChanged: listener => { changed = listener; return () => unsubscribed.push('changed'); },
      onReconnected: listener => { reconnected = listener; return () => unsubscribed.push('reconnected'); },
    };
  });

  afterEach(() => { vi.useRealTimers(); });

  const last = () => states[states.length - 1];

  it('publishes the baseline, then re-reads on change events and reconnects', async () => {
    const sync = createSessionPortsSync(transport, state => states.push(state));
    expect(last()).toEqual({ status: 'loading' });
    expect(replies[0].channel).toBe('runpane:ports:list');
    replies[0].resolve(list([taste]));
    await flush();
    expect(last()).toMatchObject({ status: 'ready', snapshot: { ports: [{ name: 'taste' }] } });

    changed(undefined);
    replies[1].resolve(list([taste, pages]));
    await flush();
    expect(last()).toMatchObject({ status: 'ready', snapshot: { ports: [{ name: 'taste' }, { name: 'pages' }] } });

    reconnected();
    replies[2].resolve(list([]));
    await flush();
    expect(last()).toMatchObject({ status: 'ready', snapshot: { ports: [] } });
    sync.dispose();
    expect(unsubscribed.sort()).toEqual(['changed', 'reconnected']);
  });

  it('applies a pushed list at once and discards the older read in flight', async () => {
    createSessionPortsSync(transport, state => states.push(state));
    changed(list([taste, pages]));
    expect(last()).toMatchObject({ status: 'ready', snapshot: { ports: [{ name: 'taste' }, { name: 'pages' }] } });
    replies[0].resolve(list([]));
    await flush();
    expect(last()).toMatchObject({ snapshot: { ports: [{ name: 'taste' }, { name: 'pages' }] } });
  });

  it('keeps only the newest of overlapping reads', async () => {
    createSessionPortsSync(transport, state => states.push(state));
    reconnected();
    replies[1].resolve(list([pages]));
    await flush();
    replies[0].resolve(list([taste]));
    await flush();
    expect(last()).toMatchObject({ snapshot: { ports: [{ name: 'pages' }] } });
  });

  it('reports an older daemon as unsupported and stops polling it until something changes', async () => {
    createSessionPortsSync(transport, state => states.push(state), { pollMs: 1000 });
    replies[0].reject(new Error('No Pane daemon command registered for channel "runpane:ports:list"'));
    await flush();
    expect(last()).toEqual({ status: 'unsupported' });
    vi.advanceTimersByTime(5000);
    expect(replies).toHaveLength(1);
    reconnected();
    expect(replies).toHaveLength(2);
  });

  it('polls as a backstop and surfaces other errors', async () => {
    createSessionPortsSync(transport, state => states.push(state), { pollMs: 1000 });
    replies[0].reject(new Error('tailscale: not running'));
    await flush();
    expect(last()).toEqual({ status: 'error', message: 'tailscale: not running' });
    vi.advanceTimersByTime(1000);
    expect(replies).toHaveLength(2);
  });

  it('open and close send the request shapes, surface IPC failures, then refresh', async () => {
    const sync = createSessionPortsSync(transport, state => states.push(state));
    replies[0].resolve(list([]));
    await flush();

    const opening = sync.open({ port: 5173, yes: true });
    expect(replies[1]).toMatchObject({ channel: 'runpane:ports:open', args: [{ port: 5173, yes: true }] });
    replies[1].resolve({ port: taste });
    await flush();
    expect(replies[2].channel).toBe('runpane:ports:list');
    replies[2].resolve(list([taste]));
    await opening;

    const closing = sync.close('taste');
    expect(replies[3]).toMatchObject({ channel: 'runpane:ports:close', args: [{ target: 'taste' }] });
    replies[3].resolve({ success: false, error: 'serve config locked' });
    await expect(closing).rejects.toThrow('serve config locked');
  });

  it('recognizes a replace-needs-confirmation refusal', () => {
    expect(isSessionPortConflict(new Error('tailnet port 8787 is already served (tcp); pass --yes to replace'))).toBe(true);
    expect(isSessionPortConflict(new Error('ERR_PORTS_CONFLICT: tailnet :8787 is held by a tcp entry'))).toBe(true);
    expect(isSessionPortConflict(new Error('permission denied'))).toBe(false);
    expect(isSessionPortConflict(new Error('tailnet port 8787 already serves taste (port 8787); pick another with --https-port'))).toBe(false);
  });
});
