import {
  RemoteAuthError,
  RemoteDaemonClient,
  getRemoteAuthFailureMessage,
  isAuthFailureResponse,
  type RemoteDaemonConnectionState,
  type RemoteDaemonTransport,
  type RemoteEventStreamContext,
  type RemoteRequestContext,
} from '../../../../shared/remoteClient/remoteDaemonClient';
import { readEventStreamResponse } from '../../../../shared/remoteClient/fetchEventStreamTransport';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';

export type RemoteBrowserConnectionState = RemoteDaemonConnectionState;

const RUNTIME_ID_STORAGE_KEY = 'pane.remotePwa.runtimeId';

// Safari cannot send headers on EventSource and preflights custom headers, so
// the PWA carries the token in the invoke body and the event stream URL.
const browserTransport: RemoteDaemonTransport = {
  invokeRequest(context, channel, args) {
    return {
      headers: {
        Authorization: `Bearer ${context.token}`,
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify({
        channel,
        args,
        token: context.token,
        runtimeId: context.runtimeId,
        clientLabel: context.clientLabel,
      }),
    };
  },

  async openEventStream(context) {
    if (globalThis.EventSource !== undefined) {
      await assertEventStreamAuthenticated(context);
      await readNativeEventSource(context);
      return;
    }

    const response = await fetch(endpointUrl(context, 'events'), { signal: context.signal });
    await readEventStreamResponse(response, context);
  },
};

export class RemoteDaemonBrowserClient extends RemoteDaemonClient {
  constructor(profile: RemotePaneConnectionProfile) {
    super({ profile, transport: browserTransport, runtimeId: getRuntimeId, clientLabel: getClientLabel() });
  }

  override async connect(): Promise<void> {
    try {
      await super.connect();
    } catch (error) {
      throw error instanceof Error ? this.withTailscaleHint(error) : error;
    }
  }

  createDeepgramStreamingSocket(): WebSocket {
    const url = new URL(endpointUrl({
      baseUrl: this.profile.baseUrl,
      token: this.profile.token,
      runtimeId: getRuntimeId(),
      clientLabel: getClientLabel(),
    }, 'voice/deepgram-stream'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(url.toString());
  }

  private withTailscaleHint(error: Error): Error {
    if (isNetworkFailure(error) && isTailscaleUrl(this.profile.baseUrl)) {
      const hostname = getUrlHostname(this.profile.baseUrl);
      return new Error(
        `Safari could not reach the Tailscale host${hostname ? ` ${hostname}` : ''}. ` +
        'Open Tailscale on this device, confirm it is connected to the same tailnet, then retry. ' +
        'If this only fails in Safari or a Home Screen app, temporarily disable iCloud Private Relay and Limit IP Address Tracking for this network.',
      );
    }
    return error;
  }
}

async function assertEventStreamAuthenticated(context: RemoteEventStreamContext): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (context.signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  context.signal.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(endpointUrl(context, 'events', { auth_check: '1' }), {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (isAuthFailureResponse(response.status)) {
      throw new RemoteAuthError(getRemoteAuthFailureMessage());
    }
    if (!response.ok) {
      throw new Error(`Remote event stream failed with ${response.status}`);
    }
  } finally {
    controller.abort();
    context.signal.removeEventListener('abort', abort);
  }
}

/** Resolves when the stream is aborted; rejects when EventSource reports an error. */
function readNativeEventSource(context: RemoteEventStreamContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const eventSource = new EventSource(endpointUrl(context, 'events'));
    const close = () => {
      context.signal.removeEventListener('abort', onAbort);
      eventSource.close();
    };
    const onAbort = () => {
      close();
      resolve();
    };
    if (context.signal.aborted) {
      onAbort();
      return;
    }
    context.signal.addEventListener('abort', onAbort, { once: true });

    eventSource.onopen = () => context.onOpen();
    for (const name of ['ready', 'heartbeat', 'daemon-event']) {
      eventSource.addEventListener(name, (event) => {
        context.onEvent({ event: name, data: event instanceof MessageEvent ? String(event.data ?? '') : '' });
      });
    }
    eventSource.onerror = () => {
      close();
      reject(new Error('Remote event stream failed'));
    };
  });
}

function endpointUrl(context: RemoteRequestContext, path: string, extra: Record<string, string> = {}): string {
  const url = new URL(`${context.baseUrl}/${path}`);
  const params = {
    access_token: context.token,
    runtime_id: context.runtimeId,
    client_label: context.clientLabel,
    ...extra,
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function getRuntimeId(): string {
  const existing = window.localStorage.getItem(RUNTIME_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.() ?? `remote-pwa-${Date.now().toString(36)}`;
  window.localStorage.setItem(RUNTIME_ID_STORAGE_KEY, generated);
  return generated;
}

function getClientLabel(): string {
  const platform = navigator.platform || 'Browser';
  return `Pane PWA on ${platform}`;
}

function isNetworkFailure(error: Error): boolean {
  return error.name === 'TypeError' || /fetch|load|network/i.test(error.message);
}

function isTailscaleUrl(value: string): boolean {
  return getUrlHostname(value)?.endsWith('.ts.net') ?? false;
}

function getUrlHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
