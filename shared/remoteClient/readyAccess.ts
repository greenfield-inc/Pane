import { readOnlyMarkSchema, type ReadOnlyMark } from '../types/accessLevel';
import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { RemoteDaemonTransport } from './remoteDaemonClient';

const readySchema = boundary.object({ access: boundary.optional(readOnlyMarkSchema) });

/** A host that sends no level (full access, or an older Pane) gives full access. */
function accessInReady(data: string): ReadOnlyMark | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(data), readySchema)?.access;
  } catch {
    return undefined;
  }
}

/** The transport, telling `onAccess` the level in each ready event before the client restores from it. */
export function withReadyAccess(transport: RemoteDaemonTransport, onAccess: (access: ReadOnlyMark | undefined) => void): RemoteDaemonTransport {
  return {
    invokeRequest: (context, channel, args) => transport.invokeRequest(context, channel, args),
    openEventStream: context => transport.openEventStream({
      ...context,
      onEvent: event => {
        if (event.event === 'ready') onAccess(accessInReady(event.data));
        context.onEvent(event);
      },
    }),
  };
}
