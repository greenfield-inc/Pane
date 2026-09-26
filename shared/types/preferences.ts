import { boundary, decodeBoundary, type BoundarySchema } from '../validation/boundaryDecoder';

/** Validated preference values exposed by the sandboxed preload. Failed calls reject. */
export interface PreferencesApi {
  get(key: string): Promise<string | null>;
  getAll(): Promise<Record<string, string>>;
  set(key: string, value: string): Promise<void>;
}

type PreferenceInvoke<Value> = (
  channel: 'preferences:get' | 'preferences:get-all' | 'preferences:set',
  ...args: string[]
) => Promise<Value>;

const failureSchema = boundary.object({ success: boundary.literal(false), error: boundary.string });
const preferenceMapSchema: BoundarySchema<Record<string, string>> = {
  decode(current) {
    const values = boundary.jsonObject.decode(current);
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [
      key, boundary.string.decode(current.child(key, value)),
    ]));
  },
};

function readResponse<Value, T>(value: Value, schema: BoundarySchema<T>): T {
  const response = decodeBoundary(value, boundary.union(
    boundary.object({ success: boundary.literal(true), data: schema }),
    failureSchema,
  ));
  if (!response.success) throw new Error(response.error);
  return response.data;
}

/** Decode the raw IPC envelope once, before values cross into renderer callers. */
export function createPreferencesApi<Value>(invoke: PreferenceInvoke<Value>): PreferencesApi {
  return {
    get: async key => readResponse(await invoke('preferences:get', key), boundary.nullable(boundary.string)),
    getAll: async () => readResponse(await invoke('preferences:get-all'), preferenceMapSchema),
    set: async (key, value) => {
      const response = decodeBoundary(await invoke('preferences:set', key, value), boundary.union(
        boundary.object({ success: boundary.literal(true) }),
        failureSchema,
      ));
      if (!response.success) throw new Error(response.error);
    },
  };
}
