import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import {
  loadRemoteProfiles as loadProfiles,
  saveRemoteProfiles as saveProfiles,
  type RemoteKeyValueStorage,
} from '../../../../shared/remoteClient/storage';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { isNativeMobile, nativeSecureStoreCall } from './nativeMobile';

const browserStorage: RemoteKeyValueStorage = {
  async getItem(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  async setItem(key, value) { window.localStorage.setItem(key, value); },
};
const nativeStorage: RemoteKeyValueStorage = {
  async getItem(key) {
    const result = await nativeSecureStoreCall('get', { key });
    return decodeOptionalBoundary(result.value, boundary.string) ?? null;
  },
  async setItem(key, value) { await nativeSecureStoreCall('set', { key, value }); },
};
function storage(): RemoteKeyValueStorage { return isNativeMobile() ? nativeStorage : browserStorage; }

export function loadRemoteProfiles(): Promise<RemotePaneConnectionProfile[]> { return loadProfiles(storage()); }
export function saveRemoteProfiles(profiles: RemotePaneConnectionProfile[]): Promise<void> { return saveProfiles(storage(), profiles); }
