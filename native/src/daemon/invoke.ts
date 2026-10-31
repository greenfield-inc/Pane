import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

interface InvokeClient {
  invoke(channel: string, args?: unknown[]): Promise<unknown>;
}

interface IpcLikeResponse {
  success?: boolean;
  data?: unknown;
  error?: string;
}

/**
 * @public
 * Calls a daemon channel and unwraps the desktop IPC envelope
 * (`{ success, data, error }`) that most channels return, so callers get
 * the payload or an Error. The generic comes from the channel's contract.
 */
export async function invokeChannel<T>(client: InvokeClient, channel: string, args: unknown[] = []): Promise<T> {
  return unwrap<T>(await client.invoke(channel, args), channel);
}

/** How long one read from a machine the phone isn't connected to may take before it counts as unreachable. */
const MACHINE_READ_TIMEOUT_MS = 8_000;

/**
 * One read sent once, connected or not, unwrapped like `invokeChannel`. It fails after `timeoutMs`
 * without retrying, so a slow machine never holds up another's reads.
 */
export async function readChannel<T>(
  client: { read(channel: string, args: unknown[], options: { timeoutMs: number }): Promise<unknown> },
  channel: string,
  args: unknown[] = [],
  timeoutMs = MACHINE_READ_TIMEOUT_MS,
): Promise<T> {
  return unwrap<T>(await client.read(channel, args, { timeoutMs }), channel);
}

/** The payload of a desktop IPC envelope, or the response itself when it has none. */
export function unwrap<T>(response: unknown, channel: string): T {
  if (isIpcResponse(response)) {
    if (response.success === false) {
      throw new Error(response.error ?? `${channel} failed`);
    }
    return response.data as T;
  }
  return response as T;
}

function isIpcResponse(value: unknown): value is IpcLikeResponse {
  return decodeOptionalBoundary(value, boundary.object({ success: boundary.boolean })) !== undefined;
}
