import { RemotePaneClient } from '../daemon/client/remotePaneClient';
import type { ConfigManager } from './configManager';
import { applySharedCredentials, readSharedCredentials, sharedCredentialsSchema } from './sharedCredentials';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import { syncSharedCredentials, type SharedCredentialHost } from '../../../shared/types/sharedCredentials';

const SYNC_DEBOUNCE_MS = 500;
const PEER_RETRY_MS = 60_000;

/**
 * Shares integration keys between this host and every host the desktop has
 * paired with. Syncs on start, when a key changes here, and when a paired
 * host reports a settings change. No timer.
 */
export class SharedCredentialSync {
  private readonly peers = new Map<string, RemotePaneClient>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private localFingerprint = '';
  private readonly onConfigUpdated = () => {
    this.refreshPeers();
    if (this.fingerprint() !== this.localFingerprint) this.request();
  };

  constructor(private readonly configManager: ConfigManager) {}

  start(): void {
    this.configManager.on('config-updated', this.onConfigUpdated);
    this.refreshPeers();
    this.request();
  }

  async stop(): Promise<void> {
    this.configManager.off('config-updated', this.onConfigUpdated);
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([...this.peers.values()].map(peer => peer.disconnect()));
    this.peers.clear();
  }

  private request(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, SYNC_DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      const local: SharedCredentialHost = {
        read: async () => readSharedCredentials(this.configManager.getConfig()),
        apply: async credentials => { await applySharedCredentials(this.configManager, credentials); },
      };
      const peers = [...this.peers.values()].map((peer): SharedCredentialHost => ({
        read: async () => decodeBoundary(await peer.invoke('credentials:shared:get', []), sharedCredentialsSchema),
        apply: async credentials => { await peer.invoke('credentials:shared:apply', [credentials]); },
      }));
      if (peers.length > 0) await syncSharedCredentials([local, ...peers]);
    } catch (error) {
      console.warn('[SharedCredentials] Sync failed:', error instanceof Error ? error.message : String(error));
    } finally {
      this.localFingerprint = this.fingerprint();
      this.running = false;
      if (this.pending) {
        this.pending = false;
        this.request();
      }
    }
  }

  /** Changes when any shared key here is set or cleared; never contains a value. */
  private fingerprint(): string {
    return JSON.stringify(this.configManager.getConfig().sharedCredentials ?? {});
  }

  /** One event stream per paired host, so its settings changes reach this desktop. */
  private refreshPeers(): void {
    // Sharing keys needs a paired device; codeless profiles carry no pairing token.
    const profiles = (this.configManager.getConfig().remoteDaemon?.client.profiles ?? [])
      .filter(profile => !profile.tailnetMachine);
    const wanted = new Map(profiles.map(profile => [peerKey(profile), profile]));
    for (const [key, peer] of this.peers) {
      if (wanted.has(key)) continue;
      void peer.disconnect();
      this.peers.delete(key);
    }
    for (const [key, profile] of wanted) {
      if (this.peers.has(key)) continue;
      const peer = new RemotePaneClient(profile, {
        eventSink: { send: channel => { if (channel === 'remote:settings-changed') this.request(); } },
        onConnectionStateChange: (status) => {
          if (status === 'connected') this.request();
          // The client gives up after its reconnect backoff; keep listening for a host that sleeps for hours.
          if (status === 'error') setTimeout(() => { if (this.peers.get(key) === peer) void peer.connect().catch(() => undefined); }, PEER_RETRY_MS);
        },
        onResyncRequired: () => this.request(),
      });
      this.peers.set(key, peer);
      void peer.connect().catch(() => undefined);
    }
  }
}

function peerKey(profile: RemotePaneConnectionProfile): string {
  return `${profile.id}\n${profile.baseUrl}\n${profile.token}`;
}
