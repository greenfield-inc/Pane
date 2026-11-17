import type { RemoteFetch } from '@shared/remoteClient';

import { connectionMark } from './perfMarks';

/**
 * Marks each read sent and answered, and the event stream opening, against the connection
 * journeys (return, switch, launch), as `send=<channel>@<machine>`. The machine is the first
 * characters of its profile id. Repeats are logged, so a read sent twice shows twice.
 */
export function perfFetch(inner: RemoteFetch, profileId: string): RemoteFetch {
  const machine = profileId.slice(0, 6);
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/events')) {
      connectionMark(`stream-request@${machine}`, { repeat: true });
      const response = await inner(url, init);
      connectionMark(`stream-open@${machine}`, { repeat: true });
      return response;
    }
    if (!path.endsWith('/invoke')) return inner(url, init);
    // The transport writes the channel first in the body, so the head of it is enough.
    const body = typeof init?.body === 'string' ? init.body.slice(0, 160) : '';
    const channel = /"channel":"([^"]+)"/.exec(body)?.[1] ?? 'unknown';
    connectionMark(`send=${channel}@${machine}`, { repeat: true });
    try {
      const response = await inner(url, init);
      connectionMark(`read=${channel}@${machine}`, { repeat: true });
      return response;
    } catch (error) {
      connectionMark(`fail=${channel}@${machine}`, { repeat: true });
      throw error;
    }
  };
}
