import { isRemotePaneConnectionProfile, type RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

/** The Pane hosts (daemons) this phone is paired with. */
export interface SavedHosts {
  profiles: RemotePaneConnectionProfile[];
  activeId: string | null;
}

export const EMPTY_HOSTS: SavedHosts = { profiles: [], activeId: null };

/** Adds a paired host and makes it active. Pairing a host again replaces its old token. */
export function addHost(hosts: SavedHosts, profile: RemotePaneConnectionProfile): SavedHosts {
  const others = hosts.profiles.filter(p => p.baseUrl !== profile.baseUrl && p.id !== profile.id);
  return { profiles: [...others, profile], activeId: profile.id };
}

export function removeHost(hosts: SavedHosts, id: string): SavedHosts {
  const profiles = hosts.profiles.filter(p => p.id !== id);
  const activeId = hosts.activeId !== id && profiles.some(p => p.id === hosts.activeId)
    ? hosts.activeId
    : profiles[0]?.id ?? null;
  return { profiles, activeId };
}

/** Async key-value store; expo-secure-store in the app. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const INDEX_KEY = 'pane.hosts.index';

// Each profile lives under its own key: iOS Keychain items over ~2 KB can fail,
// and a profile with a tunnel note is already ~0.5 KB.
function profileKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  }
  return `pane.host.${(hash >>> 0).toString(16)}`;
}

export async function loadHosts(store: KeyValueStore): Promise<SavedHosts> {
  const index = parseIndex(await store.getItem(INDEX_KEY));
  const stored = await Promise.all(index.ids.map(id => store.getItem(profileKey(id))));
  const profiles = stored.flatMap(value => {
    const profile = parseJson(value);
    return isRemotePaneConnectionProfile(profile) ? [profile] : [];
  });
  const activeId = profiles.some(p => p.id === index.activeId) ? index.activeId : profiles[0]?.id ?? null;
  return { profiles, activeId };
}

/** Writes `next` and deletes the tokens of hosts that were in `previous` but not in `next`. */
export async function saveHosts(store: KeyValueStore, next: SavedHosts, previous: SavedHosts): Promise<void> {
  await Promise.all(next.profiles.map(p => store.setItem(profileKey(p.id), JSON.stringify(p))));
  await store.setItem(INDEX_KEY, JSON.stringify({ ids: next.profiles.map(p => p.id), activeId: next.activeId }));
  const kept = new Set(next.profiles.map(p => profileKey(p.id)));
  await Promise.all(previous.profiles
    .map(p => profileKey(p.id))
    .filter(key => !kept.has(key))
    .map(key => store.deleteItem(key)));
}

function parseIndex(value: string | null): { ids: string[]; activeId: string | null } {
  const parsed = parseJson(value);
  if (typeof parsed !== 'object' || parsed === null || !('ids' in parsed) || !Array.isArray(parsed.ids)) {
    return { ids: [], activeId: null };
  }
  const ids = parsed.ids.filter((id): id is string => typeof id === 'string');
  const activeId = 'activeId' in parsed && typeof parsed.activeId === 'string' ? parsed.activeId : null;
  return { ids, activeId };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
