import type { PaneCommandValue } from '../daemon/commandRegistry';
import { PaneError } from '../../../shared/paneError';
import {
  encodeGlassesPairingCode,
  GLASSES_COMMANDS,
  GLASSES_PAIRING_SECRET_PREFIX,
  type GlassesPairingComputer,
  type GlassesRevokeEverywhereResult,
  type GlassesVouchResult,
  type GlassesVouchSkipReason,
} from '../../../shared/types/glasses';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { glassesListSchema, revokeGlassesOnComputers, type GlassesRevokeComputer } from '../../../shared/glassesRevoke';
import { RemoteRequestError } from '../../../shared/remoteClient/remoteDaemonClient';
import {
  discoverTailnetMachines,
  savedSecretKey,
  type TailnetCandidate,
  type WorkspaceCall,
  type WorkspaceCallResult,
  type WorkspaceProbe,
} from './tailnetMachines';

/** The glasses a vouch is for, taken from their own token's record on this computer. */
export interface VouchedGlasses {
  label: string;
  phoneId: string;
}

export interface GlassesVouchDependencies {
  readStatus: () => Promise<string | null>;
  probe: WorkspaceProbe;
  call: WorkspaceCall;
  /** This computer's saved passwords, keyed by `savedSecretKey`. */
  savedSecrets: ReadonlyMap<string, string>;
}

/** Runs one command on this computer and returns its answer. */
export type LocalInvoke = (channel: string, args: JsonValue[]) => Promise<PaneCommandValue>;

type Outcome =
  | { kind: 'minted'; entry: GlassesPairingComputer; expiresAt: string }
  | { kind: 'held' }
  | { kind: 'skipped'; reason: GlassesVouchSkipReason };

const UPDATE_PANE: GlassesVouchSkipReason = 'update Pane there';
const REVOKED: GlassesVouchSkipReason = 'revoked here · pair from phone';
const NEEDS_PASSWORD: GlassesVouchSkipReason = 'needs its password';
const NOT_ANSWERING: GlassesVouchSkipReason = 'not answering';

const listSchema = boundary.object({
  devices: boundary.array(boundary.object({ phoneId: boundary.optional(boundary.string) })),
  revokedPhoneIds: boundary.optional(boundary.array(boundary.string)),
  funnelOn: boundary.optional(boundary.boolean),
});
const secretSchema = boundary.object({ secret: boundary.nonEmptyString, expiresAt: boundary.nonEmptyString });

/**
 * Asks each of your other computers that lacks these glasses for a pairing secret for them, as
 * this computer's owner, and packs the secrets into one pairing code. The computers come only from
 * this computer's own discovery: yours, online, with Pane answering. Each computer mints its own
 * secret, so device tokens never leave the computer that issued them. A computer that revoked
 * these glasses, or runs a Pane too old to remember revokes, is never asked for a secret.
 */
export async function vouchForGlasses(glasses: VouchedGlasses, dependencies: GlassesVouchDependencies): Promise<GlassesVouchResult> {
  const { call, savedSecrets } = dependencies;
  const { list, candidates } = await discoverMyComputers(dependencies, 'asked none of them for the glasses');

  const ask = async (machine: TailnetMachine): Promise<Outcome> => {
    const stateReason = skipReasonForState(machine.state);
    if (stateReason) return { kind: 'skipped', reason: stateReason };
    const candidate = candidates.get(machine.dnsName);
    if (!candidate) return { kind: 'skipped', reason: NOT_ANSWERING };
    const secret = savedSecrets.get(savedSecretKey(list.domain, machine.name));

    const listed = await call(candidate, GLASSES_COMMANDS.list, [], secret);
    if (listed.kind !== 'answered' || !listed.ok) return { kind: 'skipped', reason: skipReasonForFailure(listed) };
    const held = decodeOptionalBoundary(listed.result, listSchema);
    if (!held) return { kind: 'skipped', reason: NOT_ANSWERING };
    // A Pane that predates revoke markers can't keep a revoke from being undone here.
    if (!held.revokedPhoneIds) return { kind: 'skipped', reason: UPDATE_PANE };
    if (held.revokedPhoneIds.includes(glasses.phoneId)) return { kind: 'skipped', reason: REVOKED };
    if (held.devices.some((device) => device.phoneId === glasses.phoneId)) return { kind: 'held' };
    if (held.funnelOn) return { kind: 'skipped', reason: 'Funnel is on' };

    // `unlessRevoked` closes the gap between the list and the mint: a revoke in between still holds.
    const minted = await call(candidate, GLASSES_COMMANDS.createPairingSecret, [{ deviceName: glasses.label, phoneId: glasses.phoneId, unlessRevoked: true }], secret);
    if (minted.kind !== 'answered' || !minted.ok) {
      if (minted.kind === 'answered' && minted.code === 'ERR_GLASSES_REVOKED_HERE') return { kind: 'skipped', reason: REVOKED };
      return { kind: 'skipped', reason: skipReasonForFailure(minted) };
    }
    const result = decodeOptionalBoundary(minted.result, secretSchema);
    if (!result || !result.secret.startsWith(GLASSES_PAIRING_SECRET_PREFIX)) return { kind: 'skipped', reason: NOT_ANSWERING };
    return { kind: 'minted', entry: { name: machine.name, url: machine.url, secret: result.secret }, expiresAt: result.expiresAt };
  };

  const mine = list.machines.filter((machine) => machine.mine);
  const outcomes = await Promise.all(mine.map(async (machine) => ({ machine, outcome: await ask(machine) })));
  const minted = outcomes.flatMap(({ outcome }) => (outcome.kind === 'minted' ? [outcome] : []))
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  const skipped = outcomes.flatMap(({ machine, outcome }) => (outcome.kind === 'skipped' ? [{ name: machine.name, reason: outcome.reason }] : []))
    .sort((left, right) => left.name.localeCompare(right.name));
  // The code expires with its first secret.
  const [expiresAt] = minted.map((outcome) => outcome.expiresAt).sort();
  if (!expiresAt) return { code: null, expiresAt: null, skipped };
  return {
    code: encodeGlassesPairingCode({ v: 1, expiresAt, computers: minted.map((outcome) => outcome.entry) }),
    expiresAt,
    skipped,
  };
}

/**
 * Revokes one phone's glasses on this computer and on each of your other computers that answers,
 * as the phone's revoke-everywhere does. Each revoke keeps the glasses off that computer until the
 * phone pairs them there again. The computers come only from this computer's own discovery: yours,
 * online, with Pane answering. A computer whose Pane predates glasses never held them, so it is
 * left out of both lists.
 */
export async function revokeGlassesEverywhere(
  phoneId: string,
  self: { name: string; invoke: LocalInvoke },
  dependencies: GlassesVouchDependencies,
): Promise<GlassesRevokeEverywhereResult> {
  const { devices } = decodeBoundary(await self.invoke(GLASSES_COMMANDS.list, []), glassesListSchema);
  for (const device of devices.filter((candidate) => candidate.phoneId === phoneId)) {
    await self.invoke(GLASSES_COMMANDS.revoke, [{ id: device.id }]);
  }
  const { list, candidates } = await discoverMyComputers(dependencies, 'revoked the glasses on this computer only');

  const computers: GlassesRevokeComputer<{ candidate: TailnetCandidate; secret?: string }>[] = [];
  const notReached: GlassesRevokeEverywhereResult['notReached'] = [];
  for (const machine of list.machines.filter((candidate) => candidate.mine)) {
    // A Pane that predates describe predates glasses too.
    if (machine.state === 'outdated') continue;
    const candidate = candidates.get(machine.dnsName);
    if (machine.state !== 'available' || !candidate) {
      notReached.push({ name: machine.name, reason: machine.state === 'offline' ? 'offline' : skipReasonForState(machine.state) ?? NOT_ANSWERING });
      continue;
    }
    computers.push({ machine, profile: { candidate, secret: dependencies.savedSecrets.get(savedSecretKey(list.domain, machine.name)) } });
  }

  const result = await revokeGlassesOnComputers(computers, [], phoneId, async ({ candidate, secret }, channel, args) => {
    const answer = await dependencies.call(candidate, channel, args, secret);
    if (answer.kind === 'answered' && answer.ok) return answer.result;
    throw answer.kind === 'answered'
      ? new RemoteRequestError(answer.message ?? `refused with ${answer.statusCode}`, answer.statusCode, answer.code ?? null)
      : new Error(answer.detail);
  });
  const names = new Map(computers.map(({ machine }) => [machine.dnsName, machine.name]));
  for (const dnsName of result.pending) notReached.push({ name: names.get(dnsName) ?? dnsName, reason: NOT_ANSWERING });
  return {
    revoked: [self.name, ...result.revoked],
    notReached: notReached.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** This computer's discovery, keeping the address each machine was probed at for the calls that follow. */
async function discoverMyComputers(
  dependencies: GlassesVouchDependencies,
  outcome: string,
): Promise<{ list: Extract<TailnetMachineList, { ok: true }>; candidates: Map<string, TailnetCandidate> }> {
  const candidates = new Map<string, TailnetCandidate>();
  const list = await discoverTailnetMachines({
    readStatus: dependencies.readStatus,
    probe: (machine, secret) => {
      candidates.set(machine.dnsName, machine);
      return dependencies.probe(machine, secret);
    },
    savedSecrets: dependencies.savedSecrets,
  });
  if (!list.ok) {
    throw new PaneError(
      'ERR_GLASSES_DISCOVERY_FAILED',
      `This computer could not list your other computers (${list.reason}), so it ${outcome}.`,
      list.fix,
    );
  }
  return { list, candidates };
}

function skipReasonForState(state: TailnetMachine['state']): GlassesVouchSkipReason | null {
  switch (state) {
    case 'available': return null;
    case 'password-required': return NEEDS_PASSWORD;
    case 'outdated': return UPDATE_PANE;
    default: return NOT_ANSWERING;
  }
}

function skipReasonForFailure(answer: WorkspaceCallResult): GlassesVouchSkipReason {
  if (answer.kind !== 'answered' || answer.ok) return NOT_ANSWERING;
  if (answer.code === 'ERR_UNKNOWN_CHANNEL') return UPDATE_PANE;
  if (answer.statusCode === 401 || answer.statusCode === 429) return NEEDS_PASSWORD;
  return NOT_ANSWERING;
}
