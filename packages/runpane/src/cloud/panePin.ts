import type { CloudDeps } from './commands';
import type { CloudProvider } from './provider';
import type { CloudHostRecord, PinnedPane } from './store';
import { hostProvider } from './wallet';

export type PanePinResult =
  | { host: string; written: true; pinned: string | null }
  | { host: string; written: false; reason: string };

/**
 * Writes the coordinator's pinned Pane (or its absence) into one Session. The Session's daemon installs
 * only a `runpane:cloud:upgrade` request equal to this pin, so the coordinator can relay a pin but never
 * choose one. A sleeping Session is not woken: it gets the pin the next time the laptop wakes or repairs it.
 */
export async function pushPanePin(
  record: CloudHostRecord,
  pin: PinnedPane | null,
  deps: CloudDeps,
  givenProvider?: CloudProvider,
): Promise<PanePinResult> {
  const host = record.profile.cloud.hostname;
  try {
    const provider = givenProvider ?? await hostProvider(deps, await deps.store.readCredentials(), record);
    const sandbox = await provider.get(record.profile.cloud.sandboxId);
    if (sandbox.state !== 'running') return { host, written: false, reason: `sandbox is ${sandbox.providerState}` };
    await deps.bootstrap.writePanePin(provider.handle(record.profile.cloud.sandboxId), pin);
    return { host, written: true, pinned: pin?.version ?? null };
  } catch (error) {
    return { host, written: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Writes the pin into every running Session (after `coordinator deploy` sets or removes it). */
export async function refreshPanePins(records: readonly CloudHostRecord[], pin: PinnedPane | null, deps: CloudDeps): Promise<PanePinResult[]> {
  const results: PanePinResult[] = [];
  for (const record of records) {
    if (!record.profile.baseUrl) continue;
    results.push(await pushPanePin(record, pin, deps));
  }
  return results;
}
