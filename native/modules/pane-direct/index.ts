import { NativeModule, requireOptionalNativeModule } from 'expo';

/** What `connect` needs to reach a computer over pane-direct. */
export interface DirectConnectConfig {
  /** The computer's iroh node id (`pane-direct serve`'s `ready.nodeId`). */
  nodeId: string;
  relayUrls: string[];
  /** `ip:port` addresses to try directly; same-network ones work without internet or DNS. */
  directAddrs: string[];
  /** The computer's own name, `<id>.<domain>`: TLS is opened to it (SNI). */
  serverName: string;
  /** base64url SHA-256 of the computer's SubjectPublicKeyInfo; any other key is refused. */
  fingerprint: string;
}

export interface DirectConnection {
  id: number;
  /** Plain HTTP to `127.0.0.1:<port>` reaches the computer over TLS. */
  port: number;
}

/** `path`: the QUIC connection is up, on a direct or relayed path. `error`: it is down or redialing. */
export type DirectEvent =
  | { t: 'ready'; port: number }
  | { t: 'path'; path: 'direct' | 'relay'; rttMs: number }
  | { t: 'error'; message: string }
  | { t: 'closed' };

declare class PaneDirectNativeModule extends NativeModule<{ onEvent: (payload: { id: number; event: string }) => void }> {
  available: boolean;
  connect(config: string): Promise<DirectConnection>;
  close(id: number): void;
}

const native = requireOptionalNativeModule<PaneDirectNativeModule>('PaneDirect');

/** False in builds without the native library (Expo Go, an Android build without Rust). */
export const directAvailable = native?.available ?? false;

export function connect(config: DirectConnectConfig): Promise<DirectConnection> {
  if (!native) return Promise.reject(new Error('This build has no direct connections.'));
  return native.connect(JSON.stringify(config));
}

export function close(id: number): void {
  native?.close(id);
}

/** Calls `listener` with each event of connection `id` until it is removed. */
export function addEventListener(id: number, listener: (event: DirectEvent) => void): { remove(): void } {
  if (!native) return { remove: () => undefined };
  return native.addListener('onEvent', payload => {
    // SAFETY: the native side forwards the library's own JSON events (direct/src/ffi.rs).
    if (payload.id === id) listener(JSON.parse(payload.event) as DirectEvent);
  });
}
