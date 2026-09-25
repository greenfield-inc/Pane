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
  const response = await client.invoke(channel, args);
  if (isIpcResponse(response)) {
    if (response.success === false) {
      throw new Error(response.error ?? `${channel} failed`);
    }
    return response.data as T;
  }
  return response as T;
}

function isIpcResponse(value: unknown): value is IpcLikeResponse {
  return typeof value === 'object' && value !== null && ('success' in value || 'data' in value || 'error' in value);
}
