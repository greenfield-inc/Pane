import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import type { NotifyQueue } from './notify/notifyQueue';
import type { ConfigManager } from './configManager';
import type { MachineConnections } from './machineConnections';
import { onePassword } from './onePassword';
import { localHostLabel, paneSecretStore, secretLeaseStore } from './paneSecrets';
import { SecretLeaseService, type LeaseMachineLink } from './secretLeaseService';

let service: SecretLeaseService | null = null;

/** The desktop's lease service, or null on a machine that doesn't start leases (a headless host). */
export function secretLeaseService(): SecretLeaseService | null {
  return service;
}

/**
 * Test builds only (never a packaged app): `PANE_TEST_SECRET_LEASE_MS` and
 * `PANE_TEST_SECRET_LEASE_REMINDER_MS` shorten leases so expiry and renewal run in minutes.
 */
function testTiming(packaged: boolean): () => { lengthMs?: number; reminderMs?: number } {
  return () => {
    if (packaged) return {};
    const read = (name: string) => {
      const value = Number(process.env[name]);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    return { lengthMs: read('PANE_TEST_SECRET_LEASE_MS'), reminderMs: read('PANE_TEST_SECRET_LEASE_REMINDER_MS') };
  };
}

/** The desktop's saved machines, with their connections, for pushing leases. */
function machineLinks(machines: MachineConnections): LeaseMachineLink[] {
  const states = new Map(machines.list().filter(machine => machine.id !== LOCAL_MACHINE_ID).map(machine => [machine.id, machine]));
  return machines.remotes().flatMap(remote => {
    const state = states.get(remote.id);
    return state ? [{ id: remote.id, name: state.label, online: state.status === 'online', invoke: remote.invoke }] : [];
  });
}

const reminderCards = new Map<string, string>();

/** Starts leases on the desktop: renewal reminders, and pushing again to a machine that reconnects without its lease. */
export function startSecretLeases(deps: {
  configManager: ConfigManager;
  machines: MachineConnections;
  notifyQueue: () => NotifyQueue | undefined;
  packaged: boolean;
}): SecretLeaseService {
  const store = secretLeaseStore();
  service = new SecretLeaseService({
    store,
    secrets: paneSecretStore,
    onePassword,
    config: () => deps.configManager.getConfig(),
    updateConfig: update => deps.configManager.updateConfigWith(update),
    machines: () => machineLinks(deps.machines),
    hostLabel: localHostLabel,
    testTiming: testTiming(deps.packaged),
    postReminder: lease => {
      const queue = deps.notifyQueue();
      if (!queue) return;
      const names = lease.secrets.map(secret => secret.name);
      const id = `lease-renew-${lease.id}`;
      reminderCards.set(lease.id, id);
      void queue.ask({
        id,
        // The queue words the title and fills in the length, as for any lease card.
        question: {
          ui: 'approve',
          title: 'Extend lease',
          context: `It ends at ${new Date(lease.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Extending reads 1Password again; ignored, it ends on time.`,
          lease: { project: lease.project, names, renews: lease.id },
        },
        source: { name: 'Pane', agent: 'Pane' },
      }).catch(() => undefined).finally(() => reminderCards.delete(lease.id));
    },
    closeReminder: leaseId => {
      const id = reminderCards.get(leaseId);
      if (!id) return;
      reminderCards.delete(leaseId);
      deps.notifyQueue()?.endWorkerQuestion(id, 'the lease renewed or ended');
    },
  });
  void store.ready().then(() => service?.armReminders());
  deps.machines.subscribe(event => {
    if (event.type === 'resync' && event.machineId !== LOCAL_MACHINE_ID) void service?.repushTo(event.machineId);
  });
  return service;
}
