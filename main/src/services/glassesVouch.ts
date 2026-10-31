import { PaneError } from '../../../shared/paneError';
import {
  encodeGlassesPairingCode,
  GLASSES_COMMANDS,
  GLASSES_PAIRING_SECRET_PREFIX,
  type GlassesPairingComputer,
  type GlassesVouchResult,
  type GlassesVouchSkipReason,
} from '../../../shared/types/glasses';
import type { TailnetMachine } from '../../../shared/types/workspaceAccess';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
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
  // Discovery probes each machine at its Tailscale address; the calls below reuse that address.
  const candidates = new Map<string, TailnetCandidate>();
  const list = await discoverTailnetMachines({
    readStatus: dependencies.readStatus,
    probe: (machine, secret) => {
      candidates.set(machine.dnsName, machine);
      return dependencies.probe(machine, secret);
    },
    savedSecrets,
  });
  if (!list.ok) {
    throw new PaneError(
      'ERR_GLASSES_VOUCH_DISCOVERY_FAILED',
      `This computer could not list your other computers (${list.reason}), so it asked none of them for the glasses.`,
      list.fix,
    );
  }

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
