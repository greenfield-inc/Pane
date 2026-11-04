import type { RemoteDaemonTransport, RemoteFetch } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

import { DemoWorkspace } from './demoWorkspace';

/**
 * "Try a demo": a Pane host that lives in the app. It answers the real client's `/health`,
 * `/invoke` and `/events` in memory, so every screen runs unchanged with sample data and nothing
 * leaves the phone. `.invalid` never resolves, so a request that slipped past it would fail.
 */
const DEMO_BASE_URL = 'https://studio-mac.demo.invalid';
const DEMO_DOMAIN = 'demo.invalid';
const HEARTBEAT_MS = 5_000;

export const DEMO_PROFILE: RemotePaneConnectionProfile = {
  id: 'pane-demo',
  label: 'studio-mac',
  baseUrl: DEMO_BASE_URL,
  token: '',
  transport: 'http+sse',
  // A computer "on Tailscale", so Your computers lists the sample machines and no push registers.
  tailnetMachine: 'studio-mac',
  tailnetDomain: DEMO_DOMAIN,
};

export function isDemoUrl(url: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.demo\.invalid(?=[/:]|$)/.test(url);
}

export function isDemoProfile(profile: Pick<RemotePaneConnectionProfile, 'baseUrl'>): boolean {
  return isDemoUrl(profile.baseUrl);
}

let workspace = new DemoWorkspace();

/** Starts the demo over with fresh sample data. */
export function resetDemoHost(now: number = Date.now()): void {
  workspace.dispose();
  workspace = new DemoWorkspace(now);
}

/** `fetch` and `transport` for a `RemoteDaemonClient`, answered by the demo workspace. */
export function demoConnection(): { fetch: RemoteFetch; transport: RemoteDaemonTransport } {
  return {
    fetch: async (url, init) => {
      const path = url.replace(/^https:\/\/[^/]+/, '');
      if (path === '/health') return jsonResponse({ ok: true });
      if (path === '/invoke' && init?.body) {
        const request = JSON.parse(init.body) as { channel: string; args: unknown[] };
        try {
          return jsonResponse({ ok: true, result: await workspace.invoke(request.channel, request.args) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResponse({ ok: false, error: { message, code: 'ERR_DEMO' } }, 400);
        }
      }
      return jsonResponse({ ok: false, error: { message: 'Not part of the demo' } }, 404);
    },
    transport: {
      invokeRequest: (context, channel, args) => ({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args, runtimeId: context.runtimeId, clientLabel: context.clientLabel }),
      }),
      openEventStream: context => new Promise<void>(resolve => {
        context.onOpen();
        const send = (event: string, data: JsonValue) => context.onEvent({ event, data: JSON.stringify(data) });
        const heartbeat = setInterval(() => send('heartbeat', { timestamp: new Date().toISOString() }), HEARTBEAT_MS);
        const unsubscribe = workspace.subscribe((channel, args) => send('daemon-event', { channel, args, timestamp: new Date().toISOString() }));
        context.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        }, { once: true });
        send('ready', { replay: 'none' });
      }),
    },
  };
}

function jsonResponse(value: JsonValue, status = 200): Awaited<ReturnType<RemoteFetch>> {
  return { ok: status < 400, status, body: null, json: async () => value };
}
