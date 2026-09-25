import { isRemotePaneConnectionProfile, type RemotePaneConnectionProfile } from '../types/remoteDaemon';

/** Async key-value store: localStorage in the PWA, expo-secure-store in the app. */
export interface RemoteKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const SAVED_PROFILES_KEY = 'pane.remotePwa.savedProfiles';
const RUNTIME_ID_KEY = 'pane.remotePwa.runtimeId';

export async function loadRemoteProfiles(storage: RemoteKeyValueStorage): Promise<RemotePaneConnectionProfile[]> {
  return parseProfiles(await storage.getItem(SAVED_PROFILES_KEY));
}

export function saveRemoteProfiles(
  storage: RemoteKeyValueStorage,
  profiles: RemotePaneConnectionProfile[],
): Promise<void> {
  return storage.setItem(SAVED_PROFILES_KEY, JSON.stringify(profiles));
}

/** Returns this install's stable runtime ID, creating and saving one on first use. */
export async function getOrCreateRuntimeId(
  storage: RemoteKeyValueStorage,
  createId: () => string,
): Promise<string> {
  const existing = await storage.getItem(RUNTIME_ID_KEY);
  if (existing) {
    return existing;
  }
  const generated = createId();
  await storage.setItem(RUNTIME_ID_KEY, generated);
  return generated;
}

function parseProfiles(value: string | null): RemotePaneConnectionProfile[] {
  try {
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(isRemotePaneConnectionProfile) : [];
  } catch {
    return [];
  }
}
