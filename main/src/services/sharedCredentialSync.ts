import type { ConfigManager } from './configManager';
import type { MachineConnections } from './machineConnections';
import { applySharedCredentials, readSharedCredentials, sharedCredentialsSchema } from './sharedCredentials';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import { syncSharedCredentials, type SharedCredentialHost } from '../../../shared/types/sharedCredentials';

const SYNC_DEBOUNCE_MS = 500;

/**
 * Shares integration keys between this host and every host the desktop has
 * saved, over the desktop's one connection to each. Syncs on start, when a key
 * changes here, when a saved host (re)connects, and when it reports a settings
 * change. No timer.
 */
export class SharedCredentialSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private localFingerprint = '';
  private unsubscribe: (() => void) | null = null;
  private readonly onConfigUpdated = () => {
    if (this.fingerprint() !== this.localFingerprint) this.request();
  };

  constructor(
    private readonly configManager: ConfigManager,
    private readonly machines: Pick<MachineConnections, 'subscribe' | 'remotes'>,
  ) {}

  start(): void {
    this.configManager.on('config-updated', this.onConfigUpdated);
    // A computer reached over Tailscale shares keys only with its owner and refuses everyone else.
    this.unsubscribe = this.machines.subscribe((event) => {
      if (event.type === 'machines' || event.machineId === LOCAL_MACHINE_ID) return;
      if (event.type === 'resync' || event.channel === 'remote:settings-changed') this.request();
    });
    this.request();
  }

  async stop(): Promise<void> {
    this.configManager.off('config-updated', this.onConfigUpdated);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
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
      const peers = this.machines.remotes().map((peer): SharedCredentialHost => ({
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
}
