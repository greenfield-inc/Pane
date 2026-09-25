import { PaneSseParser } from '../sseParser';
import {
  RemoteAuthError,
  getRemoteAuthFailureMessage,
  isAuthFailureResponse,
  type RemoteDaemonTransport,
  type RemoteEventStreamContext,
  type RemoteFetch,
  type RemoteFetchResponse,
  type RemoteRequestContext,
} from './remoteDaemonClient';

/**
 * Sends the token only in the Authorization header and reads `/events` from
 * a streaming fetch body. React Native's XHR-based fetch resolves only after
 * the whole body arrives, so pass `fetch` from `expo/fetch` in the app (Expo
 * SDK 57 also installs it as the global fetch).
 *
 * The client never sets Accept-Encoding. The platform HTTP stack adds it and
 * then inflates the gzip stream itself (browsers, NSURLSession, OkHttp);
 * setting it by hand turns off OkHttp's transparent decompression.
 */
export function createFetchEventStreamTransport(streamingFetch: RemoteFetch): RemoteDaemonTransport {
  return {
    invokeRequest(context, channel, args) {
      return {
        headers: { ...authHeaders(context), 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args, runtimeId: context.runtimeId, clientLabel: context.clientLabel }),
      };
    },

    async openEventStream(context) {
      const response = await streamingFetch(`${context.baseUrl}/events`, {
        headers: { ...authHeaders(context), Accept: 'text/event-stream' },
        signal: context.signal,
      });
      await readEventStreamResponse(response, context);
    },
  };
}

/** Checks the response status, then feeds every SSE event to the context. */
export async function readEventStreamResponse(
  response: RemoteFetchResponse,
  context: Pick<RemoteEventStreamContext, 'signal' | 'onOpen' | 'onEvent'>,
): Promise<void> {
  if (isAuthFailureResponse(response.status)) {
    throw new RemoteAuthError(getRemoteAuthFailureMessage());
  }
  if (!response.ok || !response.body) {
    throw new Error(`Remote event stream failed with ${response.status}`);
  }

  context.onOpen();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new PaneSseParser();
  try {
    while (!context.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        context.onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function authHeaders(context: RemoteRequestContext) {
  return {
    Authorization: `Bearer ${context.token}`,
    'X-Pane-Remote-Runtime-Id': context.runtimeId,
    'X-Pane-Client-Label': context.clientLabel,
  };
}

/**
 * URL and headers for the daemon's voice WebSocket. React Native's WebSocket
 * takes headers as its third argument: `new WebSocket(url, undefined, { headers })`.
 */
export function createVoiceSocketRequest(context: RemoteRequestContext) {
  return {
    url: `${context.baseUrl.replace(/^http/, 'ws')}/voice/deepgram-stream`,
    headers: authHeaders(context),
  };
}
