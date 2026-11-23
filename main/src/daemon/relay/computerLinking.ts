import { PaneError, reasonOf } from '../../../../shared/paneError';
import { isRelayComputerUnder, parseRelayPairingLink, relayComputerAddress, type RelayPairingLink } from '../../../../shared/remoteClient/relay';
import { RemoteRequestError } from '../../../../shared/remoteClient/remoteDaemonClient';
import { decodeComputerRoutesReport, type ComputerRoutesReport } from '../../../../shared/types/remoteComputers';
import {
  RELAY_CLIENT_COMMANDS,
  type LinkPreview,
  type LinkRedeemResult,
  type RelayComputer,
  type RelayComputerOffer,
  type RelayExchangeRequest,
  type RelayPairedEvent,
} from '../../../../shared/types/relay';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PairingRoute } from '../httpApiServer';
import type { PairingExchangeRequest, PairingExchangeResult, PairingRefusal } from './pairingExchange';
import { relayComputerSchema, type CallComputer, type LinkedComputer, type PostToComputer, type RelayLinks } from './relayLinks';

/** The relay service's side of a trade: checking and spending secrets, and this computer's relay identity. */
interface PairingHost {
  checkSecret(secret: string, source: string): { ok: true; expiresAt: string } | PairingRefusal;
  exchangeSecret(request: PairingExchangeRequest): Promise<PairingExchangeResult & { computer?: RelayComputer }>;
  computerInfo(): RelayComputer | undefined;
  clientAddress(remoteAddress: string | undefined, remotePort: number | undefined): string | null;
}

const offerSchema = boundary.object({
  computer: relayComputerSchema,
  token: boundary.nonEmptyString,
  routes: boundary.optional(boundary.json),
});
const groupSchema = boundary.array(boundary.object({ id: boundary.nonEmptyString, name: boundary.nonEmptyString }));
const previewSchema = boundary.object({ ok: boundary.literal(true), group: groupSchema, expiresAt: boundary.nonEmptyString });
const exchangeSchema = boundary.object({
  ok: boundary.literal(true),
  token: boundary.nonEmptyString,
  computer: relayComputerSchema,
  linked: boundary.array(boundary.object({ computer: relayComputerSchema, token: boundary.nonEmptyString })),
  routes: boundary.optional(boundary.json),
});
const failureSchema = boundary.object({
  error: boundary.object({ code: boundary.optional(boundary.string), message: boundary.optional(boundary.string) }),
});
const tokenSchema = boundary.object({ token: boundary.nonEmptyString });

/**
 * The maker's side of a link or QR code, behind the pairing listener's `/pair/preview` and
 * `/pair/exchange`. A phone becomes a phone client; a computer that offers its own token becomes a
 * linked computer saved in `client.computers`, and every computer linked with this one hands it a
 * token too.
 */
export function createPairingRoute(deps: {
  host: PairingHost;
  links: RelayLinks;
  routesReport(): ComputerRoutesReport | undefined | Promise<ComputerRoutesReport | undefined>;
  onPaired(event: RelayPairedEvent): void;
}): PairingRoute {
  const { host, links } = deps;
  return {
    preview: async ({ secret, source }) => {
      const checked = host.checkSecret(secret, source);
      if (!checked.ok) return checked;
      const self = host.computerInfo();
      if (!self) return { ok: false, status: 503, code: 'ERR_RELAY_NOT_READY', message: 'Phone access is still starting on this computer. Try again in a moment.' };
      const group = [{ id: self.id, name: self.name }, ...links.linked().map((profile) => ({ id: profile.relay.computerId, name: profile.label }))];
      return { ok: true, group, expiresAt: checked.expiresAt };
    },
    exchange: async (request) => {
      if (request.computer === undefined) {
        const result = await host.exchangeSecret(request);
        if (!result.ok) return result;
        deps.onPaired({ kind: 'phone', label: result.client.label });
        return { ...result, linked: await links.grantsFor({ label: result.client.label, phoneId: request.phoneId }, request.known ?? []) };
      }
      const offer = decodeOptionalBoundary(request.computer, offerSchema);
      if (!offer) return { ok: false, status: 400, code: 'ERR_PAIRING_BAD_REQUEST', message: 'The computer did not say who it is, so the code was not used.' };
      // Checked before the secret is spent, so a refused computer leaves the code for another.
      try {
        links.checkPeer(offer.computer);
      } catch (error) {
        return { ok: false, status: 400, code: error instanceof PaneError ? error.code : 'ERR_PAIRING_BAD_REQUEST', message: reasonOf(error) };
      }
      const result = await host.exchangeSecret({ ...request, label: offer.computer.name, computerId: offer.computer.id });
      if (!result.ok) return result;
      const computerId = await links.saveComputer({ computer: offer.computer, token: offer.token, routes: decodeComputerRoutesReport(offer.routes) });
      deps.onPaired({ kind: 'computer', label: offer.computer.name, computerId });
      const [linked, routes] = await Promise.all([links.computerGrantsFor(offer.computer, request.known ?? []), deps.routesReport()]);
      return routes ? { ...result, linked, routes } : { ...result, linked };
    },
    clientAddress: (remoteAddress, remotePort) => host.clientAddress(remoteAddress, remotePort),
  };
}

interface ComputerLinkingDeps {
  links: RelayLinks;
  /** This computer, or undefined while phone access is off. */
  self(): RelayComputer | undefined;
  routesReport(): ComputerRoutesReport | undefined | Promise<ComputerRoutesReport | undefined>;
  post: PostToComputer;
  call: CallComputer;
  log?(line: string): void;
}

interface FetchedPreview {
  link: RelayPairingLink;
  group: Array<{ id: string; name: string }>;
  expiresAt: string;
}

function refusal(code: string, maker: string): PaneError {
  switch (code) {
    case 'ERR_PAIRING_CODE_USED':
      return new PaneError(code, `This code was already used: each link works once, so ${maker} was not linked.`, `Copy a new link from Add a device › Computer on ${maker}.`);
    case 'ERR_PAIRING_CODE_EXPIRED':
      return new PaneError(code, `This code expired, so ${maker} was not linked.`, `Copy a new link from Add a device › Computer on ${maker}.`);
    case 'ERR_PAIRING_CODE_INVALID':
      return new PaneError(code, `${maker} has no such link waiting, so it was not linked.`, `Copy a new link from Add a device › Computer on ${maker}.`);
    case 'ERR_PAIRING_LOCKED':
      return new PaneError(code, `${maker} paused pairing for 15 minutes after several wrong codes, so it was not linked.`, 'Try the link again in 15 minutes.');
    default:
      return new PaneError(code, `${maker} did not accept this link (${code}), so it was not linked.`, `Copy a new link from Add a device › Computer on ${maker}.`);
  }
}

/**
 * The redeemer's side: this computer opens another computer's one-time link. It previews the link
 * without spending it, trades it as a computer, saves the maker and every computer linked with it,
 * hands each of them a token to call this computer, then links each computer already linked here
 * with each of theirs. Asking the person first is the client's job.
 */
export class ComputerLinking {
  constructor(private readonly deps: ComputerLinkingDeps) {}

  /** Who the link joins this computer with, without spending it. */
  async preview(text: string): Promise<LinkPreview> {
    const { group, expiresAt } = await this.fetchPreview(this.parse(text));
    const here = this.deps.links.linked();
    return {
      maker: group[0].name,
      makerGroup: group.map((member) => member.name),
      here: here.map((profile) => profile.label),
      // Linking lets the maker run agents here, so it asks unless this computer reaches the maker already. The maker writes `group`, so it never decides this.
      needsConfirm: !here.some((profile) => profile.relay.computerId === group[0].id),
      expiresAt,
    };
  }

  async redeem(text: string): Promise<LinkRedeemResult> {
    const { links } = this.deps;
    const link = this.parse(text);
    const self = this.deps.self();
    if (!self) {
      throw new PaneError('ERR_RELAY_OFF', `Phone access is off on this computer, so it was not linked with ${link.name}.`, 'Open Settings › Remote Access › Add a device on this computer, which turns phone access on, then open the link again.');
    }
    if (link.domain !== self.domain) {
      throw new PaneError('ERR_RELAY_LINK_OUTSIDE_DOMAIN', `${link.name} uses the relay ${link.domain} and this computer uses ${self.domain}, so they were not linked.`,
        'Set the same Relay address in Settings › Remote Access › Phones and glasses on both computers, then copy a new link.');
    }
    if (link.computerId === self.id) throw new PaneError('ERR_RELAY_LINK_SELF', 'This is this computer\'s own link, so nothing was linked.', 'Open the link on another computer.');
    const { group } = await this.fetchPreview(link);
    const maker = group[0].name;
    const before = links.linked();
    const minted = await links.mintFor({ id: link.computerId, name: maker });
    let answer: { status: number; json: unknown };
    try {
      const offer: RelayComputerOffer = { computer: self, token: minted.token };
      const routes = await this.deps.routesReport();
      if (routes) offer.routes = routes;
      const request: RelayExchangeRequest = { secret: link.secret, label: self.name, known: before.map((profile) => profile.relay.computerId), computer: offer };
      answer = await this.deps.post(relayComputerAddress(link), '/pair/exchange', request, maker);
    } catch (error) {
      await links.dropClient(minted.clientId);
      throw new PaneError('ERR_LINK_UNREACHABLE', `Can't reach ${maker}: ${reasonOf(error)}. Nothing was linked.`, `Check that Pane is open on ${maker} with phone access on, then open the link again.`);
    }
    const result = decodeOptionalBoundary(answer.json, exchangeSchema);
    if (!result || result.computer.id !== link.computerId || !isRelayComputerUnder(result.computer, link.domain)) {
      await links.dropClient(minted.clientId);
      throw result ? new PaneError('ERR_PAIRING_WRONG_COMPUTER', `A different computer answered for ${maker}, so nothing was linked.`, `Copy a new link from Add a device › Computer on ${maker}.`)
        : refusal(decodeOptionalBoundary(answer.json, failureSchema)?.error.code ?? `HTTP_${answer.status}`, maker);
    }
    await links.saveComputer({ computer: result.computer, token: result.token, routes: decodeComputerRoutesReport(result.routes) });

    // The maker's linked computers handed out tokens; each gets one to call this computer.
    const theirs: RelayComputer[] = [result.computer];
    for (const grant of result.linked) {
      const peer = grant.computer;
      if (peer.id === self.id || peer.id === result.computer.id || !isRelayComputerUnder(peer, link.domain)) continue;
      await links.saveComputer({ computer: peer, token: grant.token, linkedBy: maker });
      const back = await links.mintFor(peer);
      try {
        await this.deps.call(this.profileFor(peer.id), RELAY_CLIENT_COMMANDS.saveLink, [{ peer: self, token: back.token }]);
        theirs.push(peer);
      } catch (error) {
        await links.dropClient(back.clientId);
        this.deps.log?.(`[relay] ${peer.name} did not save the link to this computer: ${reasonOf(error)}`);
      }
    }

    // Each computer linked here before joins each computer of the maker's group.
    const theirIds = new Set(theirs.map((computer) => computer.id));
    const ours = await this.infoFor(before.filter((profile) => !theirIds.has(profile.relay.computerId)));
    await Promise.all(ours.flatMap(({ profile, computer }) => theirs.map((peer) => this.join(profile, computer, peer))));
    return { linked: theirs.map((computer) => computer.name) };
  }

  private parse(text: string): RelayPairingLink {
    const link = parseRelayPairingLink(text);
    if (!link) {
      throw new PaneError('ERR_LINK_INVALID', 'That is not a Pane link, so nothing was linked.', 'Copy the whole link from Add a device › Computer on the other computer, then paste it again.');
    }
    return link;
  }

  private async fetchPreview(link: RelayPairingLink): Promise<FetchedPreview> {
    let answer: { status: number; json: unknown };
    try {
      answer = await this.deps.post(relayComputerAddress(link), '/pair/preview', { secret: link.secret }, link.name);
    } catch (error) {
      throw new PaneError('ERR_LINK_UNREACHABLE', `Can't reach ${link.name}: ${reasonOf(error)}. Nothing was linked.`, `Check that Pane is open on ${link.name} with phone access on, then open the link again.`);
    }
    const preview = decodeOptionalBoundary(answer.json, previewSchema);
    if (!preview) throw refusal(decodeOptionalBoundary(answer.json, failureSchema)?.error.code ?? `HTTP_${answer.status}`, link.name);
    if (preview.group[0]?.id !== link.computerId) {
      throw new PaneError('ERR_PAIRING_WRONG_COMPUTER', `A different computer answered for ${link.name}, so nothing was linked.`, `Copy a new link from Add a device › Computer on ${link.name}.`);
    }
    return { link, group: preview.group, expiresAt: preview.expiresAt };
  }

  private profileFor(relayId: string): LinkedComputer {
    const profile = this.deps.links.linked().find((candidate) => candidate.relay.computerId === relayId);
    if (!profile) throw new Error(`${relayId} is not saved on this computer.`);
    return profile;
  }

  /** What each linked computer says about itself; one that does not answer is left out. */
  private async infoFor(profiles: LinkedComputer[]): Promise<Array<{ profile: LinkedComputer; computer: RelayComputer }>> {
    const answers = await Promise.all(profiles.map(async (profile) => {
      try {
        const computer = decodeOptionalBoundary(await this.deps.call(profile, RELAY_CLIENT_COMMANDS.computer, []), relayComputerSchema);
        return computer?.id === profile.relay.computerId ? [{ profile, computer }] : [];
      } catch (error) {
        this.deps.log?.(`[relay] ${profile.label} did not answer, so it was not linked with the new computers: ${reasonOf(error)}`);
        return [];
      }
    }));
    return answers.flat();
  }

  /** Links two computers this one can call, as a phone does: each mints a token for the other, and each saves the other's. */
  private async join(ourProfile: LinkedComputer, ours: RelayComputer, theirs: RelayComputer): Promise<void> {
    try {
      await this.joinPair(ourProfile, ours, theirs);
    } catch (error) {
      this.deps.log?.(`[relay] ${ours.name} and ${theirs.name} were not linked: ${reasonOf(error)}`);
    }
  }

  private async joinPair(ourProfile: LinkedComputer, ours: RelayComputer, theirs: RelayComputer): Promise<void> {
    const theirProfile = this.profileFor(theirs.id);
    const mint = async (on: LinkedComputer, peer: RelayComputer): Promise<string | null> => {
      try {
        return decodeOptionalBoundary(await this.deps.call(on, RELAY_CLIENT_COMMANDS.mintLink, [{ peer }]), tokenSchema)?.token ?? null;
      } catch (error) {
        if (error instanceof RemoteRequestError && error.code === 'ERR_RELAY_ALREADY_LINKED') return null;
        throw error;
      }
    };
    const forTheirs = await mint(ourProfile, theirs);
    const forOurs = await mint(theirProfile, ours);
    if (forTheirs) await this.deps.call(theirProfile, RELAY_CLIENT_COMMANDS.saveLink, [{ peer: ours, token: forTheirs }]);
    if (forOurs) await this.deps.call(ourProfile, RELAY_CLIENT_COMMANDS.saveLink, [{ peer: theirs, token: forOurs }]);
  }
}
