import type { CloudDeps } from './commands';
import { describeRevocation, revokeSessionCoordinatorClients } from './coordinatorClients';
import { loadCoordinatorProvider, reconfigureCoordinator, requireCoordinatorDeployment, saveCoordinatorDeployment } from './coordinatorDeploy';
import { pushDirectory } from './coordinatorSync';

/**
 * `runpane cloud coordinator revoke-clients|revoke-caller`: take the coordinator's credentials back.
 * `revoke-clients` revokes its paired client on every awake cloud Session (coordinatorClients.ts).
 * `revoke-caller` refuses one caller of the coordinator's API: `revokedCallers` lives in this machine's
 * deployment record, so every rewrite of the coordinator config (deploy, github set, doppler set) keeps it.
 */

export const COORDINATOR_REVOKE_USAGE = `Revoking the coordinator's credentials:
  runpane cloud coordinator revoke-clients --yes [--json]
                     revoke the coordinator's paired client on every awake cloud Session and forget its token here
  runpane cloud coordinator revoke-caller <user:name|host|Session id> [--undo] [--json]
                     refuse (or accept again) one caller of the coordinator's API`;

const CALLER_ID_PATTERN = /^(user:[A-Za-z0-9_-]{1,60}|[A-Za-z0-9_-]{1,128})$/u;

interface RevokeArgs {
  sub: 'revoke-clients' | 'revoke-caller';
  json: boolean;
  yes: boolean;
  undo: boolean;
  caller?: string;
}

export function isCoordinatorRevokeCommand(argv: readonly string[]): boolean {
  return argv[0] === 'revoke-clients' || argv[0] === 'revoke-caller';
}

export function parseCoordinatorRevokeArgs(argv: readonly string[]): RevokeArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'revoke-clients' && sub !== 'revoke-caller') throw new Error(COORDINATOR_REVOKE_USAGE);
  const args: RevokeArgs = { sub, json: false, yes: false, undo: false };
  for (const arg of rest) {
    if (arg === '--json') args.json = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--undo' && sub === 'revoke-caller') args.undo = true;
    else if (!arg.startsWith('-') && sub === 'revoke-caller' && args.caller === undefined) args.caller = arg;
    else throw new Error(`Unknown option for runpane cloud coordinator ${sub}: ${arg}\n\n${COORDINATOR_REVOKE_USAGE}`);
  }
  if (sub === 'revoke-caller' && !args.caller) throw new Error(COORDINATOR_REVOKE_USAGE);
  return args;
}

export async function runCoordinatorRevoke(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const args = parseCoordinatorRevokeArgs(argv);
  return args.sub === 'revoke-clients' ? revokeClients(args, deps) : revokeCaller(args, deps);
}

async function revokeClients(args: RevokeArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) {
    throw new Error('runpane cloud coordinator revoke-clients takes the coordinator\'s access to every awake cloud Session away '
      + '(idle-stop skips them until coordinator deploy pairs a new client). Rerun with --yes to confirm.');
  }
  const outcome = await revokeSessionCoordinatorClients(deps);
  // A deployed coordinator learns at once that those tokens are gone.
  const directory = await pushDirectory(deps);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: outcome.failed.length === 0, revoked: outcome.done, notRevoked: outcome.failed, directory }, null, 2));
  } else {
    deps.stdout(describeRevocation(outcome));
  }
  return outcome.failed.length === 0 ? 0 : 1;
}

async function revokeCaller(args: RevokeArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireCoordinatorDeployment(deps);
  const callerId = await resolveCallerId(args.caller ?? '', deps);
  const current = new Set(deployment.revokedCallers ?? []);
  if (args.undo) current.delete(callerId);
  else current.add(callerId);
  const next = { ...deployment, revokedCallers: [...current].sort() };
  if (next.revokedCallers.length === 0) delete next.revokedCallers;
  const { provider } = await loadCoordinatorProvider(deps);
  await reconfigureCoordinator(provider, next);
  await saveCoordinatorDeployment(deps, next);
  const revoked = next.revokedCallers ?? [];
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, callerId, revoked: !args.undo, revokedCallers: revoked }, null, 2));
  } else {
    deps.stdout(`coordinator: caller ${callerId} is ${args.undo ? 'accepted again' : 'refused (403 auth-revoked)'}; revoked callers: ${revoked.join(', ') || 'none'}.`);
  }
  return 0;
}

/** `user:<name>` as given; a host's label, hostname or Session id becomes that Session's peer caller id. */
async function resolveCallerId(selector: string, deps: CloudDeps): Promise<string> {
  const trimmed = selector.trim();
  if (trimmed.startsWith('user:')) {
    if (!CALLER_ID_PATTERN.test(trimmed)) throw new Error('A user caller is user:<name> (letters, digits, "_" and "-").');
    return trimmed;
  }
  const record = (await deps.store.listHosts()).find((candidate) => (
    candidate.profile.cloud.hostname === trimmed || candidate.profile.label === trimmed || candidate.profile.cloud.sessionId === trimmed
  ));
  const callerId = record?.profile.cloud.sessionId ?? trimmed;
  if (!CALLER_ID_PATTERN.test(callerId)) throw new Error(`"${selector}" is neither user:<name> nor a cloud host or Session id.`);
  return callerId;
}
