import type { CloudDeps } from './commands';
import { PERSONAL_ORG, type BoatOrg, type CloudProvider } from './provider';
import type { CloudCredentials, CloudHostRecord } from './store';

/**
 * boat wallets (organizations). Every boat account has one active wallet, which a request that names
 * no org bills, and which anyone can switch from the dashboard. A sandbox's wallet is fixed when it is
 * created, so `runpane cloud` names the wallet on every create and scopes each host's calls to it.
 */

/** Finds a wallet by id, name (case-insensitive, as boat's GET /orgs lists it) or `personal`. */
export async function resolveBoatOrg(provider: CloudProvider, wanted: string): Promise<BoatOrg> {
  const orgs = await provider.listOrgs();
  const needle = wanted.trim().toLowerCase();
  const byId = orgs.find((org) => org.id.toLowerCase() === needle);
  const matches = byId ? [byId] : orgs.filter((org) => org.name.toLowerCase() === needle);
  if (matches.length > 1) throw new Error(`Several boat organizations are named "${wanted}"; pass the id: ${matches.map((org) => org.id).join(', ')}.`);
  const [match] = matches;
  if (!match) {
    throw new Error(`No boat wallet "${wanted}". Yours: ${orgs.map((org) => `${org.name} (${org.id})${org.active ? ' [active]' : ''}`).join(', ')}.`);
  }
  return { id: match.id, name: match.name };
}

export function describeOrg(org: BoatOrg): string {
  return org.id === PERSONAL_ORG.id ? 'Personal' : `${org.name} (${org.id})`;
}

/**
 * A provider scoped to the wallet this host bills. The wallet is fixed when the sandbox is created;
 * a host recorded before wallets were tracked gets it from boat (the sandbox's `team`) once, and keeps it.
 */
export async function hostProvider(deps: Pick<CloudDeps, 'createProvider' | 'store'>, credentials: CloudCredentials, record: CloudHostRecord): Promise<CloudProvider> {
  if (!record.meta.boatOrg) {
    const sandbox = await deps.createProvider(credentials).get(record.profile.cloud.sandboxId);
    if (!sandbox.org) return deps.createProvider(credentials);
    record.meta.boatOrg = sandbox.org;
    await deps.store.writeHost(record);
  }
  return deps.createProvider(credentials, record.meta.boatOrg.id);
}
