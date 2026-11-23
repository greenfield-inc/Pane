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
import { localHostLabel, paneSecretStore, type PaneSecretStore } from './paneSecrets';
import { cloudSecretRecords, GITHUB_SIGN_IN_KEY, readGithubToken } from './cloudSecrets';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import {
  syncSharedCredentials,
  syncSharedNotifySwitch,
  type SharedCredential,
  type SharedCredentialHost,
  type SharedCredentials,
  type SharedNotifySwitchHost,
} from '../../../shared/types/sharedCredentials';

const SYNC_DEBOUNCE_MS = 500;

/**
 * Shares integration keys and the Approvals on/off switch between this host and
 * every host the desktop has saved, over the desktop's one connection to each.
 * Syncs on start, when either changes here, when a saved host (re)connects, and
 * when it reports a settings change. No timer. A Pane Cloud VM only receives:
 * the person's choice of Pane secrets, their GitHub token and the Approvals switch, never read back.
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

  /** The GitHub token as last sent, so a VM gets a new record only when the token changes. */
  private githubRecord: SharedCredential | null = null;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly machines: Pick<MachineConnections, 'subscribe' | 'remotes'>,
    private readonly secrets: () => PaneSecretStore = paneSecretStore,
    private readonly githubToken: () => Promise<string | null> = readGithubToken,
    /** Saved machines that are the person's Pane Cloud VMs, as Pane Cloud lists them (a VM's relay id mapped to its saved computer). */
    private readonly cloudMachines: () => ReadonlySet<string> = () => new Set(),
  ) {}

  /** Syncs again soon, as when Pane Cloud's list of the person's VMs changes. */
  resync(): void {
    this.request();
  }

  /**
   * Sends the person's secrets to a newly paired cloud VM now, before its first Session starts, so
   * the Session's agents begin signed in. Throws when the VM can't be reached.
   */
  async sendToCloudVm(machineId: string): Promise<void> {
    const vm = this.machines.remotes().find((remote) => remote.id === machineId);
    if (!vm) {
      throw new PaneError('ERR_CLOUD_SECRETS_NOT_SENT', 'Pane could not send your secrets: this computer has no connection to the cloud machine.', 'Try New cloud Session again.');
    }
    try {
      await vm.invoke('credentials:cloud:apply', [await this.cloudSecrets()]);
    } catch (error) {
      throw new PaneError('ERR_CLOUD_SECRETS_NOT_SENT', `Pane could not send your secrets to the cloud machine: ${reasonOf(error)}.`, 'Check this computer is online, then try New cloud Session again.');
    }
  }

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

  /** Protected so a test can wait for each sync to end. */
  protected async run(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      const local: SharedCredentialHost = {
        read: async () => ({
          ...readSharedCredentials(this.configManager.getConfig()),
          paneSecrets: await this.secrets().exportForSync(),
          paneSecretReferences: this.secrets().exportReferencesForSync(),
          paneCloudSecretChoice: this.secrets().exportCloudChoiceForSync(),
        }),
        apply: async credentials => {
          await applySharedCredentials(this.configManager, credentials);
          if (credentials.paneSecrets) await this.secrets().applyFromSync(credentials.paneSecrets);
          if (credentials.paneSecretReferences) await this.secrets().applyReferencesFromSync(credentials.paneSecretReferences);
          if (credentials.paneCloudSecretChoice) await this.secrets().applyCloudChoiceFromSync(credentials.paneCloudSecretChoice);
        },
      };
      const remotes = this.machines.remotes();
      const cloud = this.cloudMachines();
      const isCloudVm = (peer: { id: string }) => cloud.has(peer.id);
      // A cloud VM is sent the person's choice of secrets below and never read.
      const peers = remotes.filter((peer) => !isCloudVm(peer)).map((peer): SharedCredentialHost => ({
        read: async () => decodeBoundary(await peer.invoke('credentials:shared:get', []), sharedCredentialsSchema),
        apply: async credentials => { await peer.invoke('credentials:shared:apply', [credentials]); },
      }));
      const localSwitch: SharedNotifySwitchHost = {
        read: async () => readNotifySwitch(this.configManager.getConfig()),
        apply: async notifySwitch => { await applyNotifySwitch(this.configManager, notifySwitch); },
      };
      // A machine too old for these commands refuses them and is skipped; its keys still sync.
      const switchPeers = remotes.filter((peer) => !isCloudVm(peer)).map((peer): SharedNotifySwitchHost => ({
        read: async () => decodeBoundary(await peer.invoke('notify:switch:get', []), sharedNotifySwitchSchema),
        apply: async notifySwitch => { await peer.invoke('notify:switch:apply', [notifySwitch]); },
      }));
      if (peers.length > 0) await syncSharedCredentials([local, ...peers]);
      if (switchPeers.length > 0) await syncSharedNotifySwitch([localSwitch, ...switchPeers]);
      const cloudVms = remotes.filter(isCloudVm);
      if (cloudVms.length > 0) {
        const secrets = await this.cloudSecrets();
        // The Approvals switch goes to a cloud VM too, and its own is never read back.
        const notifySwitch = readNotifySwitch(this.configManager.getConfig());
        await Promise.all(cloudVms.map((vm) => Promise.all([
          vm.invoke('credentials:cloud:apply', [secrets]),
          vm.invoke('notify:switch:apply', [notifySwitch]),
        ]).catch((error) => {
          console.warn(`[SharedCredentials] Could not send secrets to cloud machine ${vm.id}: ${reasonOf(error)}`);
        })));
      }
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

  /**
   * What a cloud VM gets: this computer's merged Pane secrets and the GitHub token from gh, less what
   * the person turned off, and the choice itself, which the VM applies to every sender. No integration
   * keys and no 1Password references: a VM keeps only values, and only on its secrets volume.
   */
  private async cloudSecrets(): Promise<SharedCredentials> {
    const records = await this.secrets().exportForSync();
    const token = await this.githubToken();
    if (token && this.githubRecord?.value !== token) this.githubRecord = { value: token, updatedAt: new Date().toISOString(), source: localHostLabel() };
    if (token && this.githubRecord && records[GITHUB_SIGN_IN_KEY]?.value == null) records[GITHUB_SIGN_IN_KEY] = this.githubRecord;
    const secrets: SharedCredentials = { paneSecrets: cloudSecretRecords(records, this.secrets().cloudChoice()) };
    const choice = this.secrets().exportCloudChoiceForSync();
    if (choice) secrets.paneCloudSecretChoice = choice;
    return secrets;
  }

  /** Changes when any shared key or Pane secret here is set or cleared, or the switch changes; never contains a value. */
  private fingerprint(): string {
    const config = this.configManager.getConfig();
    return JSON.stringify([config.sharedCredentials ?? {}, config.paneSecrets ?? {}, config.paneSecretReferences ?? {}, config.paneCloudSecretChoice ?? null, this.switchFingerprint()]);
  }

  private switchFingerprint(): string {
    return JSON.stringify(readNotifySwitch(this.configManager.getConfig()));
  }
}
