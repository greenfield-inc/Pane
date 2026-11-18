import type { RemoteFetch } from '@shared/remoteClient';
import { REMOTE_READ_CHANNELS } from '@shared/remoteClient/readChannels';

import { connectionMark } from './perfMarks';

/**
 * Marks each request sent and answered, and the event stream opening, against the connection
 * journeys (return, switch, launch). A read logs as `send=<channel>#<args>@<machine>` and
 * `read=…`, so the same read sent twice shows twice with the same key; anything else logs as
 * `write=<channel>@<machine>`. The machine and the arguments are short hashes, never names.
 * Wired only into a perf build (createClient).
 */
export function perfFetch(inner: RemoteFetch, profileId: string): RemoteFetch {
  const machine = shortHash(profileId);
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/events')) {
      connectionMark(`stream-request@${machine}`, { repeat: true });
      const response = await inner(url, init);
      connectionMark(`stream-open@${machine}`, { repeat: true });
      return response;
    }
    if (!path.endsWith('/invoke')) return inner(url, init);
    const { channel, args } = requestOf(init?.body);
    const read = REMOTE_READ_CHANNELS.has(channel);
    const key = read ? `${channel}#${shortHash(JSON.stringify(args))}@${machine}` : `${channel}@${machine}`;
    connectionMark(`${read ? 'send' : 'write'}=${key}`, { repeat: true });
    try {
      const response = await inner(url, init);
      if (read) connectionMark(`read=${key}`, { repeat: true });
      return response;
    } catch (error) {
      connectionMark(`fail=${key}`, { repeat: true });
      throw error;
    }
  };
}

function requestOf(body: string | undefined): { channel: string; args: unknown } {
  try {
    const parsed = JSON.parse(body ?? '') as { channel?: unknown; args?: unknown };
    return { channel: typeof parsed.channel === 'string' ? parsed.channel : 'unknown', args: parsed.args };
  } catch {
    return { channel: 'unknown', args: null };
  }
}

/** Four base-36 characters of an FNV-1a hash: tells values apart in a log without revealing them. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(-4);
}
