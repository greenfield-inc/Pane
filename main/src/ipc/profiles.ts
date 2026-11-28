import type { IpcMain } from 'electron';
import { PaneError, paneErrorText, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { profileDetailsSchema, profileFileChangesSchema } from '../../../shared/types/profileEditor';
import { PROFILE_SYNC_CHANGED_EVENT, PROFILE_SYNC_CHANNELS } from '../../../shared/types/profileSync';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import { getPaneEventSink } from '../core/runtime';
import { ProfileEditor, parseYaml } from '../services/agentFarm/profileEditor';
import { ProfileSyncHost, profilesOffError, runProfileSyncCommand } from '../services/agentFarm/profileSync';
import { ProfileSyncCoordinator, type ProfileSyncPeer } from '../services/agentFarm/profileSyncCoordinator';
import { profilesOn } from '../services/agentFarm/profilesFeature';
import type { MachineConnections } from '../services/machineConnections';
import { resolvePeer, testPeers } from '../services/sessionMove/peer';
import { getAppDirectory } from '../utils/appDirectory';
import { computerName } from '../utils/computerName';
import type { AppServices } from './types';
import { teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';

type ProfilesResponse<Data> = { success: true; data: Data } | { success: false; error: string };

async function respond<Data>(work: () => Promise<Data> | Data): Promise<ProfilesResponse<Data>> {
  try {
    // Behind the Profiles switch (D-474): off, the tab doesn't exist and nothing here reads or writes.
    if (!profilesOn()) throw new PaneError('PROFILES_OFF', 'Profiles is off on this computer.', 'Turn it on in Settings > Advanced > Experimental > Profiles.');
    return { success: true, data: await work() };
  } catch (error) {
    return { success: false, error: error instanceof PaneError ? paneErrorText(error) : `Pane couldn't change its profiles: ${reasonOf(error)}.` };
  }
}

const text = boundary.string;
const kindSchema = boundary.enumeration('subagent', 'skill', 'reference');

/** How long a Session's start or reload waits for its profile to come up to date from your other computers. */
const SESSION_SYNC_WAIT_MS = 10_000;

/** This computer's profile sync: its own records and packs, and (on a desktop) the sync across computers. */
interface ProfileSyncService {
  host: ProfileSyncHost;
  coordinator: ProfileSyncCoordinator;
  /** Starts syncing with the desktop's saved machines; a Pane without them syncs only with loopback test peers. */
  start(machines: MachineConnections | null): void;
  stop(): void;
  /** Brings one profile's plugin up to date here (and on `machineId`) before a Session starts or reloads it; never throws. */
  bringCurrent(plugin: string, machineId?: string): Promise<void>;
}

let profileSyncService: ProfileSyncService | null = null;

/** The profile sync registerProfileHandlers set up; null before it. */
export function profileSync(): ProfileSyncService | null {
  return profileSyncService;
}

/** Waits for `work` at most `ms`, then goes on; the work carries on in the background. */
async function atMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

/**
 * The Profiles tab (T-63 PR 5): renderer-only channels on this computer's own Agent Farm folder.
 * Every file Pane writes stays inside `<PANE_DIR>/agent-farm/{plugins,drafts,avatars}` (ProfileEditor's
 * path checks). After a change, Sessions using the plugin are re-checked so they show the changed dot,
 * and the change is synced to your other computers (PR 6). `runpane profiles` (PR 7) reuses both.
 *
 * Every channel refuses while the Profiles switch is off (D-474), as main has no such channels; sync
 * then neither starts, records, nor answers other computers (`profile-sync:*` refuse with
 * PROFILE_SYNC_OFF_CODE, which their desktops show as "Profiles is off there"). Turning the switch on
 * starts syncing without a restart. `commandRegistry` is absent in tests that drive only the tab.
 */
export function registerProfileHandlers(ipcMain: Pick<IpcMain, 'handle'>, services: AppServices, paneDir: string = getAppDirectory(), commandRegistry?: PaneCommandRegistry): void {
  const recheckSessions = () => {
    void services.orchestrationSessionManager?.refreshPluginHashes(true)
      .catch(error => console.warn(`[Profiles] Could not re-check Sessions' profiles after a change: ${reasonOf(error)}`));
  };
  // The name the sidebar and the relay give this computer.
  const name = () => computerName() || 'this computer';
  const machineId = () => services.configManager?.getConfig().machineId ?? 'unknown';
  let machines: MachineConnections | null = null;
  const host = new ProfileSyncHost({
    paneDir,
    machine: machineId,
    name,
    onApplied: () => {
      recheckSessions();
      // The tab here reads the plugins again, and a desktop syncing with this computer sends the change on.
      getPaneEventSink().send(PROFILE_SYNC_CHANGED_EVENT);
    },
    onPeerSeen: machine => coordinator.peerSeen(machine),
    // Checked again once a call has the lock, so one that waited refuses after the switch goes off (review F-11).
    enabled: profilesOn,
  });
  const peers = (): ProfileSyncPeer[] => {
    const saved: ProfileSyncPeer[] = (machines?.list() ?? []).filter(machine => machine.id !== LOCAL_MACHINE_ID && machine.kind === 'remote').map(machine => ({
      key: machine.id,
      name: machine.label,
      online: machine.status === 'offline' ? false : undefined,
      invoke: (channel, args, timeoutMs) => {
        if (!machines) throw new PaneError('ERR_MACHINE_UNKNOWN', `${machine.label} isn't connected.`, 'Sync again.');
        return machines.invokeOn(machine.id, channel, args, timeoutMs);
      },
    }));
    // Isolated dev instances on one computer (PANE_MOVE_TEST_PEERS), reached through their daemon sockets.
    const tests: ProfileSyncPeer[] = testPeers().map(peer => ({
      key: `test:${peer.name}`,
      name: peer.name,
      invoke: (channel, args, timeoutMs) => resolvePeer(peer.name, services.configManager).invoke(channel, args.map(arg => decodeBoundary(arg ?? null, boundary.json)), boundary.json, timeoutMs),
    }));
    return [...saved, ...tests];
  };
  const coordinator = new ProfileSyncCoordinator({
    local: host,
    peers,
    machine: machineId,
    enabled: profilesOn,
    onStatus: status => getPaneEventSink().send('profiles:sync-status', status),
  });
  let unsubscribe: (() => void) | null = null;
  let wasOn = profilesOn();
  // Turning the switch on starts syncing at once, without a restart.
  const onConfigUpdated = () => {
    const on = profilesOn();
    if (on && !wasOn) coordinator.request();
    wasOn = on;
  };
  profileSyncService = {
    host,
    coordinator,
    start(next) {
      machines = next;
      services.configManager?.on('config-updated', onConfigUpdated);
      const online = new Set<string>();
      unsubscribe = next?.subscribe(event => {
        if (event.type === 'machines') {
          // A computer that comes back online gets what it missed.
          let returned = false;
          for (const machine of event.machines) {
            if (machine.id === LOCAL_MACHINE_ID) continue;
            if (machine.status === 'online' && !online.has(machine.id)) { online.add(machine.id); returned = true; }
            if (machine.status !== 'online') online.delete(machine.id);
          }
          if (returned) coordinator.request();
        } else if (event.machineId !== LOCAL_MACHINE_ID && (event.type === 'resync' || event.channel === PROFILE_SYNC_CHANGED_EVENT)) {
          coordinator.request();
        }
      }) ?? null;
      coordinator.request();
    },
    stop() {
      services.configManager?.off('config-updated', onConfigUpdated);
      unsubscribe?.();
      unsubscribe = null;
      coordinator.stop();
    },
    async bringCurrent(plugin, machineId) {
      // Off, a Session starts exactly as it does without Profiles: no pre-sync, no push.
      if (!profilesOn() || !peers().length) return;
      await atMost(coordinator.syncPlugin(plugin, machineId), SESSION_SYNC_WAIT_MS);
    },
  };

  // A Session on this computer starts or reloads its profile from an up-to-date copy.
  services.orchestrationSessionManager?.attachProfileSync(plugin => profileSyncService?.bringCurrent(plugin) ?? Promise.resolve());

  const editor = new ProfileEditor({
    paneDir,
    machine: name,
    // Each change runs under sync's lock and is recorded before it lets go (review F-2).
    exclusive: (plugin, work) => host.exclusive(plugin, work),
    onChanged: () => {
      recheckSessions();
      // Every save here is sent to your other computers once it is recorded.
      getPaneEventSink().send(PROFILE_SYNC_CHANGED_EVENT);
      coordinator.request();
    },
  });
  ipcMain.handle('profiles:list', () => respond(() => editor.list()));
  ipcMain.handle('profiles:read', (_event, plugin: PaneCommandValue, file: PaneCommandValue) => respond(() => editor.read(decodeBoundary(plugin, text), decodeBoundary(file, text))));
  ipcMain.handle('profiles:save', (_event, plugin: PaneCommandValue, changes: PaneCommandValue) => respond(() => editor.save(decodeBoundary(plugin, text), decodeBoundary(changes, profileFileChangesSchema))));
  ipcMain.handle('profiles:new-profile', (_event, name: PaneCommandValue, agent: PaneCommandValue) => respond(() => editor.newProfile(decodeBoundary(name, text), decodeBoundary(agent, text))));
  ipcMain.handle('profiles:new-file', (_event, plugin: PaneCommandValue, profile: PaneCommandValue, kind: PaneCommandValue, name: PaneCommandValue) =>
    respond(() => editor.newFile(decodeBoundary(plugin, text), decodeBoundary(profile, text), decodeBoundary(kind, kindSchema), decodeBoundary(name, text))));
  ipcMain.handle('profiles:restore', (_event, plugin: PaneCommandValue) => respond(() => editor.restore(decodeBoundary(plugin, text))));
  ipcMain.handle('profiles:photos', () => respond(() => editor.photos()));
  ipcMain.handle('profiles:set-photo', (_event, ref: PaneCommandValue, base64: PaneCommandValue) => respond(() => editor.setPhoto(decodeBoundary(ref, text), decodeBoundary(base64, text))));
  ipcMain.handle('profiles:set-details', (_event, plugin: PaneCommandValue, profile: PaneCommandValue, details: PaneCommandValue) =>
    respond(() => editor.setDetails(decodeBoundary(plugin, text), decodeBoundary(profile, text), decodeBoundary(details, profileDetailsSchema))));
  // The preview's YAML view and a Markdown file's front-matter: the renderer has no YAML parser of its own.
  ipcMain.handle('profiles:parse-yaml', (_event, source: PaneCommandValue) => respond(() => parseYaml(decodeBoundary(source, text))));
  ipcMain.handle('profiles:remove-photo', (_event, ref: PaneCommandValue) => respond(() => editor.removePhoto(decodeBoundary(ref, text))));
  ipcMain.handle('profiles:sync-status', () => respond(() => coordinator.status()));
  ipcMain.handle('profiles:sync-now', () => respond(() => coordinator.syncNow()));

  // What your other computers' desktops call on this one. Your own machines only, as a Session move,
  // and only while Profiles is on here.
  for (const channel of Object.values(PROFILE_SYNC_CHANNELS)) {
    commandRegistry?.register(channel, (request: PaneCommandValue) => {
      if (!profilesOn()) throw profilesOffError();
      const teammate = teammatePaneCaller();
      if (teammate) throw new PaneError('ERR_PROFILE_SYNC_TEAMMATE', `${teammate} asked to sync profiles with this computer, and profiles sync only between one person's own computers. Nothing was changed.`, 'Share a profile by sending its files instead.');
      return runProfileSyncCommand(host, channel, request ?? null);
    });
  }
}
