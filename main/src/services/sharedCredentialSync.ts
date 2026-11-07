import type { ConfigManager } from './configManager';
import type { MachineConnections } from './machineConnections';
import { getPaneEventSink } from '../core/runtime';
import {
  applyNotifySwitch,
  applySharedCredentials,
  readNotifySwitch,
  readSharedCredentials,
  sharedCredentialsSchema,
  sharedNotifySwitchSchema,
} from './sharedCredentials';
import { paneSecretStore, type PaneSecretStore } from './paneSecrets';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import {
  syncSharedCredentials,
  syncSharedNotifySwitch,
  type SharedCredentialHost,
  type SharedNotifySwitchHost,
} from '../../../shared/types/sharedCredentials';

const SYNC_DEBOUNCE_MS = 500;

/**
 * Shares integration keys and the Approvals on/off switch between this host and
 * every host the desktop has saved, over the desktop's one connection to each.
 * Syncs on start, when either changes here, when a saved host (re)connects, and
 * when it reports a settings change. No timer.
 */
export class SharedCredentialSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private localFingerprint = '';
  private localSwitch = '';
  private unsubscribe: (() => void) | null = null;
  private readonly onConfigUpdated = () => {
    const notifySwitch = this.switchFingerprint();
    if (notifySwitch !== this.localSwitch) {
      this.localSwitch = notifySwitch;
      // A machine that saved this one but isn't saved here can only learn of it this way; the tray doesn't report it.
      getPaneEventSink().send('remote:settings-changed');
    }
    if (this.fingerprint() !== this.localFingerprint) this.request();
  };

  constructor(
    private readonly configManager: ConfigManager,
    private readonly machines: Pick<MachineConnections, 'subscribe' | 'remotes'>,
    private readonly secrets: () => PaneSecretStore = paneSecretStore,
  ) {}

  start(): void {
    this.localSwitch = this.switchFingerprint();
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
        read: async () => ({ ...readSharedCredentials(this.configManager.getConfig()), paneSecrets: await this.secrets().exportForSync() }),
        apply: async credentials => {
          await applySharedCredentials(this.configManager, credentials);
          if (credentials.paneSecrets) await this.secrets().applyFromSync(credentials.paneSecrets);
        },
      };
      const peers = this.machines.remotes().map((peer): SharedCredentialHost => ({
        read: async () => decodeBoundary(await peer.invoke('credentials:shared:get', []), sharedCredentialsSchema),
        apply: async credentials => { await peer.invoke('credentials:shared:apply', [credentials]); },
      }));
      const localSwitch: SharedNotifySwitchHost = {
        read: async () => readNotifySwitch(this.configManager.getConfig()),
        apply: async notifySwitch => { await applyNotifySwitch(this.configManager, notifySwitch); },
      };
      // A machine too old for these commands refuses them and is skipped; its keys still sync.
      const switchPeers = this.machines.remotes().map((peer): SharedNotifySwitchHost => ({
        read: async () => decodeBoundary(await peer.invoke('notify:switch:get', []), sharedNotifySwitchSchema),
        apply: async notifySwitch => { await peer.invoke('notify:switch:apply', [notifySwitch]); },
      }));
      if (peers.length > 0) await Promise.all([syncSharedCredentials([local, ...peers]), syncSharedNotifySwitch([localSwitch, ...switchPeers])]);
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

  /** Changes when any shared key or Pane secret here is set or cleared, or the switch changes; never contains a value. */
  private fingerprint(): string {
    const config = this.configManager.getConfig();
    return JSON.stringify([config.sharedCredentials ?? {}, config.paneSecrets ?? {}, this.switchFingerprint()]);
  }

  private switchFingerprint(): string {
    return JSON.stringify(readNotifySwitch(this.configManager.getConfig()));
  }
}
