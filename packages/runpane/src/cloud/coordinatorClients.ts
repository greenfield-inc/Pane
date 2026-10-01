import { promises as fs } from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { encodePairingCode } from './pairing';
import type { CloudHostRecord } from './store';

/**
 * Who the coordinator's credentials still reach, and how to take them back:
 * - each cloud Session's daemon holds a `scope: 'coordinator'` client record whose token this machine
 *   keeps (`<host>.coordinator.pairing`) and pushes in the directory. `coordinator destroy` and
 *   `coordinator revoke-clients` revoke that record on every awake Session (runpane:cloud:coordinator-client:revoke)
 *   and forget the token here; the next `coordinator deploy` pairs a fresh one on the Sessions it revoked
 *   (runpane:cloud:coordinator-client:pair), so a directory copied before can't reach them again.
 * The `revoke-clients` and `revoke-caller` commands are in coordinatorRevoke.ts.
 */

const CLIENT_CALL_TIMEOUT_MS = 20_000;
const COORDINATOR_CLIENT_LABEL = 'runpane-cloud-coordinator';

export interface CoordinatorClientsOutcome {
  /** Hostnames whose daemon dropped the coordinator's client (or re-paired it). */
  done: string[];
  /** Hostnames left as they were, with the reason (asleep, unreachable, a Pane without the channel). */
  failed: Array<{ host: string; reason: string }>;
}

/**
 * Revokes the coordinator's client on every Session this machine paired one on. A Session that can't be
 * reached keeps its record and its token here, so a later `revoke-clients` can finish the job.
 */
export async function revokeSessionCoordinatorClients(deps: CloudDeps): Promise<CoordinatorClientsOutcome> {
  const outcome: CoordinatorClientsOutcome = { done: [], failed: [] };
  for (const record of await deps.store.listHosts()) {
    const pairingPath = record.meta.coordinatorPairingPath;
    if (!pairingPath) continue;
    const host = record.profile.cloud.hostname;
    try {
      await callDaemon(record, 'runpane:cloud:coordinator-client:revoke', deps);
    } catch (error) {
      outcome.failed.push({ host, reason: describeClientError(error, host) });
      continue;
    }
    await fs.rm(pairingPath, { force: true });
    delete record.meta.coordinatorPairingPath;
    record.meta.coordinatorClientRevoked = true;
    await deps.store.writeHost(record);
    outcome.done.push(host);
  }
  return outcome;
}

const pairResultSchema = boundary.object({ token: boundary.nonEmptyString });

/** On `deploy`: pairs a fresh coordinator client on each awake Session whose client this machine revoked. */
export async function repairRevokedCoordinatorClients(deps: CloudDeps): Promise<CoordinatorClientsOutcome> {
  const outcome: CoordinatorClientsOutcome = { done: [], failed: [] };
  for (const record of await deps.store.listHosts()) {
    if (!record.meta.coordinatorClientRevoked || record.meta.coordinatorPairingPath) continue;
    const host = record.profile.cloud.hostname;
    let token: string;
    try {
      token = decodeBoundary(await callDaemon(record, 'runpane:cloud:coordinator-client:pair', deps), pairResultSchema).token;
    } catch (error) {
      outcome.failed.push({ host, reason: describeClientError(error, host) });
      continue;
    }
    const pairingPath = deps.store.coordinatorPairingPath(host);
    await fs.mkdir(path.dirname(pairingPath), { recursive: true });
    const code = encodePairingCode({ v: 1, label: COORDINATOR_CLIENT_LABEL, baseUrl: record.profile.baseUrl, token, transport: 'http+sse' });
    await fs.writeFile(pairingPath, `${code}\n`, { mode: 0o600 });
    record.meta.coordinatorPairingPath = pairingPath;
    delete record.meta.coordinatorClientRevoked;
    await deps.store.writeHost(record);
    outcome.done.push(host);
  }
  return outcome;
}

async function callDaemon(record: CloudHostRecord, channel: string, deps: CloudDeps) {
  if (!record.profile.baseUrl || !record.profile.token) throw new Error('its setup never finished (no daemon address)');
  return deps.invokeDaemon(record.profile, channel, [{}], CLIENT_CALL_TIMEOUT_MS);
}

function describeClientError(error: unknown, host: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/No Pane daemon command registered|ERR_UNKNOWN_CHANNEL/u.test(message)) {
    return 'its Pane predates coordinator-client revocation; upgrade it (runpane cloud repair) or destroy it';
  }
  if (/connect|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timed out/iu.test(message)) {
    return `not reachable (asleep? run runpane cloud wake ${host}, then rerun)`;
  }
  return message;
}

/** One line per outcome, for `destroy` and `revoke-clients`. */
export function describeRevocation(outcome: CoordinatorClientsOutcome): string {
  const lines = [outcome.done.length > 0
    ? `coordinator client revoked on ${outcome.done.join(', ')}.`
    : 'no cloud Session had a coordinator client to revoke here.'];
  for (const failure of outcome.failed) {
    lines.push(`  ${failure.host}: NOT revoked, ${failure.reason}; it still accepts the old coordinator token until runpane cloud coordinator revoke-clients --yes succeeds.`);
  }
  return lines.join('\n');
}
