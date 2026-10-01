import { boundary, decodeBoundary } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { loadCoordinatorProvider, reconfigureCoordinator, requireCoordinatorDeployment, saveCoordinatorDeployment } from './coordinatorDeploy';
import type { CoordinatorDeployment, CoordinatorSecrets, CoordinatorSecretsConfig } from './store';

/**
 * `runpane cloud coordinator doppler set|policy|status|audit|unset`, run on the user's machine once.
 * `set` mints one read-only Doppler service token per config with this machine's logged-in `doppler`
 * CLI (Doppler scopes each service token to one config), or takes one the user made, and installs it
 * 0600 on the coordinator through the provider's files API: never printed, never on a command line,
 * never saved here. From then on Sessions get their repository manifest's secrets from the coordinator
 * at creation and at every wake, with no laptop in the path.
 */

export const COORDINATOR_DOPPLER_USAGE = `Doppler secrets on the coordinator (Sessions get their repository's .runpane/secrets.json names; no laptop at runtime):
  runpane cloud coordinator doppler set --project <p> (--config <c> [--config <c>...] | --all-configs)
        [--policy default|allow-all] [--token-name <name>] [--api-base-url <url>] [--json]
                     mint a read-only service token per config with this machine's doppler CLI and install it
  runpane cloud coordinator doppler set --project <p> --config <c> --token-file <file|-> [--policy ...] [--json]
                     install a read-only service token you made (dp.st.*; service account, personal and CLI tokens are refused)
  runpane cloud coordinator doppler policy (--default | --allow-all | --deny-names <A,B_*> [--deny-configs <prd,stg>]) [--json]
                     what the coordinator withholds from every manifest (default: production/infra names, stg/prd configs)
  runpane cloud coordinator doppler status [--check] [--json]
  runpane cloud coordinator doppler audit [--limit <n>] [--json]
  runpane cloud coordinator doppler unset (--config <c>... | --all) --yes [--keep-tokens] [--json]
                     shred the tokens on the coordinator and revoke the ones this machine minted`;

const DOPPLER_TIMEOUT_MS = 30_000;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
/**
 * Service tokens only: Doppler scopes one to a single config, and `set` mints it read-only. Every other kind is
 * refused by its prefix, since this machine can't check what it reaches: a service account token can span
 * projects and configs and may write, and personal and CLI tokens act as the user.
 */
const SERVICE_TOKEN = /^dp\.st\.[A-Za-z0-9._-]{20,}$/u;
const REFUSED_TOKEN_KINDS: [prefix: string, kind: string][] = [
  ['dp.sa.', 'a service account token (it can span projects and configs and may write)'],
  ['dp.pt.', 'a personal token (it acts as you, with write access to every project)'],
  ['dp.ct.', 'a CLI token (it acts as you, with write access to every project)'],
  ['dp.scim.', 'a SCIM token'],
  ['dp.audit.', 'an audit token'],
];

/** Why `token` can't be installed, or null for a service token. */
function refusedToken(token: string): string | null {
  if (SERVICE_TOKEN.test(token)) return null;
  const kind = REFUSED_TOKEN_KINDS.find(([prefix]) => token.startsWith(prefix))?.[1];
  return `${kind ? `That is ${kind}, not a service token.` : 'That is not a Doppler service token.'} `
    + 'Only a Doppler service token (dp.st.…, scoped to one config) is accepted: create one with Access: read, or let set mint it.';
}

type Policy = CoordinatorSecrets['policy'];

interface DopplerArgs {
  sub: 'set' | 'policy' | 'status' | 'audit' | 'unset';
  json: boolean;
  yes: boolean;
  project?: string;
  configs: string[];
  allConfigs: boolean;
  tokenFile?: string;
  tokenName?: string;
  apiBaseUrl?: string;
  policy?: Policy;
  check: boolean;
  keepTokens: boolean;
  limit: number;
}

function commaList(value: string, flag: string): string[] {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${flag} takes a comma-separated list.`);
  return items;
}

export function parseCoordinatorDopplerArgs(argv: readonly string[]): DopplerArgs {
  const [sub, ...rest] = argv;
  if (sub !== 'set' && sub !== 'policy' && sub !== 'status' && sub !== 'audit' && sub !== 'unset') throw new Error(COORDINATOR_DOPPLER_USAGE);
  const args: DopplerArgs = { sub, json: false, yes: false, configs: [], allConfigs: false, check: false, keepTokens: false, limit: 50 };
  const value = (index: number, flag: string): string => {
    const next = rest[index + 1];
    if (next === undefined || (next.startsWith('--') && next !== '-')) throw new Error(`${flag} requires a value.`);
    return next;
  };
  const only = (flag: string, ...subs: DopplerArgs['sub'][]) => {
    if (!subs.includes(sub)) throw new Error(`Unknown option for runpane cloud coordinator doppler ${sub}: ${flag}`);
  };
  const setPolicy = (next: Policy) => {
    if (args.policy && (args.policy.mode !== 'custom' || next.mode !== 'custom')) throw new Error('Give one policy: --default, --allow-all, or --deny-names/--deny-configs.');
    args.policy = args.policy?.mode === 'custom' && next.mode === 'custom' ? { ...args.policy, ...next } : next;
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    switch (flag) {
      case '--json': args.json = true; break;
      case '--yes': case '-y': args.yes = true; break;
      case '--project': only(flag, 'set'); args.project = value(index++, flag); break;
      case '--config': only(flag, 'set', 'unset'); args.configs.push(value(index++, flag)); break;
      case '--all-configs': only(flag, 'set'); args.allConfigs = true; break;
      case '--all': only(flag, 'unset'); args.allConfigs = true; break;
      case '--token-file': only(flag, 'set'); args.tokenFile = value(index++, flag); break;
      case '--token-name': only(flag, 'set'); args.tokenName = value(index++, flag); break;
      case '--api-base-url': only(flag, 'set'); args.apiBaseUrl = value(index++, flag); break;
      case '--policy': {
        only(flag, 'set');
        const mode = value(index++, flag);
        if (mode !== 'default' && mode !== 'allow-all') throw new Error('--policy is default or allow-all (use coordinator doppler policy --deny-names for a custom list).');
        setPolicy({ mode });
        break;
      }
      case '--default': only(flag, 'policy'); setPolicy({ mode: 'default' }); break;
      case '--allow-all': only(flag, 'policy'); setPolicy({ mode: 'allow-all' }); break;
      case '--deny-names': only(flag, 'policy'); setPolicy({ mode: 'custom', deniedNames: commaList(value(index++, flag), flag) }); break;
      case '--deny-configs': only(flag, 'policy'); setPolicy({ mode: 'custom', deniedConfigs: commaList(value(index++, flag), flag) }); break;
      case '--check': only(flag, 'status'); args.check = true; break;
      case '--keep-tokens': only(flag, 'unset'); args.keepTokens = true; break;
      case '--limit': {
        only(flag, 'audit');
        const limit = Number(value(index++, flag));
        if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error('--limit must be 1-1000.');
        args.limit = limit;
        break;
      }
      default: throw new Error(`Unknown option for runpane cloud coordinator doppler ${sub}: ${flag}\n\n${COORDINATOR_DOPPLER_USAGE}`);
    }
  }
  for (const slug of [args.project, ...args.configs]) {
    if (slug !== undefined && !SLUG_PATTERN.test(slug)) throw new Error(`"${slug}" is not a Doppler project or config name.`);
  }
  if (args.apiBaseUrl !== undefined && !/^https?:\/\/[^\s/]+/u.test(args.apiBaseUrl)) throw new Error('--api-base-url must be an http(s) URL.');
  if (sub === 'set') {
    if (!args.project) throw new Error(`coordinator doppler set needs --project.\n\n${COORDINATOR_DOPPLER_USAGE}`);
    if (args.allConfigs === (args.configs.length > 0)) throw new Error('Pass --config <c> (repeatable) or --all-configs.');
    if (args.tokenFile && (args.allConfigs || args.configs.length !== 1)) throw new Error('--token-file installs one token: pass exactly one --config.');
    if (args.tokenFile && args.tokenName) throw new Error('--token-name names a token set mints; --token-file brings your own.');
  }
  if (sub === 'policy' && !args.policy) throw new Error(`coordinator doppler policy needs --default, --allow-all or --deny-names/--deny-configs.\n\n${COORDINATOR_DOPPLER_USAGE}`);
  if (sub === 'unset' && args.allConfigs === (args.configs.length > 0)) throw new Error('Pass --config <c> (repeatable) or --all.');
  return args;
}

export async function runCoordinatorDoppler(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const args = parseCoordinatorDopplerArgs(argv);
  switch (args.sub) {
    case 'set': return set(args, deps);
    case 'policy': return policy(args, deps);
    case 'status': return status(args, deps);
    case 'audit': return audit(args, deps);
    case 'unset': return unset(args, deps);
  }
}

// ---------------------------------------------------------------- the local doppler CLI

const createdSchema = boundary.object({ token: boundary.nonEmptyString, slug: boundary.nonEmptyString, name: boundary.optional(boundary.string) });
const configsSchema = boundary.array(boundary.object({ name: boundary.nonEmptyString }));

async function doppler(deps: CloudDeps, args: string[], what: string): Promise<string> {
  if (!deps.runLocal) throw new Error('This build cannot run the local doppler CLI.');
  let result;
  try {
    result = await deps.runLocal('doppler', args, DOPPLER_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`Could not run the doppler CLI (${error instanceof Error ? error.message : String(error)}). Install it and run doppler login, or pass --token-file.`);
  }
  if (result.exitCode !== 0) {
    // stderr is Doppler's error text; stdout may hold a token and is never shown.
    const detail = result.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
    throw new Error(`doppler could not ${what} (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}.`);
  }
  return result.stdout;
}

async function listConfigs(deps: CloudDeps, project: string): Promise<string[]> {
  const stdout = await doppler(deps, ['configs', '--project', project, '--json'], `list the configs of ${project}`);
  return decodeBoundary(JSON.parse(stdout), configsSchema).map((config) => config.name);
}

async function mintToken(deps: CloudDeps, project: string, config: string, name: string): Promise<{ token: string; slug: string }> {
  const stdout = await doppler(deps, ['configs', 'tokens', 'create', name, '--project', project, '--config', config, '--access', 'read', '--json'], `create a read-only service token for ${project}/${config}`);
  let created;
  try {
    created = decodeBoundary(JSON.parse(stdout), createdSchema);
  } catch {
    throw new Error(`doppler created a token for ${project}/${config} but its answer was not the expected JSON; revoke tokens named ${name} in Doppler (project ${project}, config ${config}, Access).`);
  }
  if (refusedToken(created.token)) throw new Error(`doppler returned an unexpected token kind for ${project}/${config}; nothing was installed.`);
  return { token: created.token, slug: created.slug };
}

async function revokeToken(deps: CloudDeps, config: CoordinatorSecretsConfig): Promise<string | null> {
  if (!config.tokenSlug) return `${config.project}/${config.config}: not minted by this machine; revoke it in Doppler yourself`;
  try {
    await doppler(deps, ['configs', 'tokens', 'revoke', '--project', config.project, '--config', config.config, '--slug', config.tokenSlug], `revoke the service token for ${config.project}/${config.config}`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------- coordinator answers

const statusSchema = boundary.object({
  ok: boundary.optional(boundary.boolean),
  enabled: boundary.optional(boundary.boolean),
  configs: boundary.optional(boundary.array(boundary.object({
    project: boundary.string,
    config: boundary.string,
    loaded: boundary.optional(boundary.boolean),
    names: boundary.optional(boundary.number),
    error: boundary.optional(boundary.string),
  }))),
  policy: boundary.optional(boundary.nullable(boundary.object({
    mode: boundary.string,
    deniedNames: boundary.optional(boundary.array(boundary.string)),
    deniedConfigs: boundary.optional(boundary.array(boundary.string)),
  }))),
});
const auditSchema = boundary.object({ entries: boundary.array(boundary.jsonObject) });
const auditEntrySchema = boundary.object({
  at: boundary.optional(boundary.string),
  callerId: boundary.optional(boundary.string),
  label: boundary.optional(boundary.nullable(boundary.string)),
  endpoint: boundary.optional(boundary.string),
  repo: boundary.optional(boundary.nullable(boundary.string)),
  ref: boundary.optional(boundary.nullable(boundary.string)),
  manifestSha: boundary.optional(boundary.nullable(boundary.string)),
  outcome: boundary.optional(boundary.string),
  configs: boundary.optional(boundary.array(boundary.object({
    config: boundary.string,
    delivered: boundary.optional(boundary.array(boundary.string)),
    withheld: boundary.optional(boundary.array(boundary.string)),
    refused: boundary.optional(boundary.nullable(boundary.string)),
  }))),
});

type SecretsStatus = ReturnType<typeof statusSchema.decode>;

async function secretsStatus(deps: CloudDeps, check: boolean): Promise<SecretsStatus | { unavailable: string }> {
  if (!deps.callCoordinatorApi) return { unavailable: 'this build cannot call the coordinator API' };
  try {
    const result = await deps.callCoordinatorApi('GET', `/cloud/secrets/status${check ? '?check=1' : ''}`, undefined, 60_000);
    if (result.status === 404) return { unavailable: 'the coordinator has no secrets service yet (redeploy it: runpane cloud coordinator deploy --yes)' };
    if (result.status !== 200) return { unavailable: `the coordinator answered HTTP ${result.status}` };
    return decodeBoundary(result.body, statusSchema);
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

function describePolicy(policy: Policy): string {
  if (policy.mode === 'allow-all') return 'allow-all (every name the manifest lists, production included; shell/Pane variables excepted)';
  if (policy.mode === 'default') return 'default (withholds PRODUCTION_*, CLOUDFLARE_*, SHOPIFY_ADMIN*, VERCEL_*, NEON_*, DOPPLER_*, *_MANAGEMENT_*; refuses stg/prd configs)';
  return `custom (withholds ${(policy.deniedNames ?? ['the built-in names']).join(', ')}; refuses configs ${(policy.deniedConfigs ?? ['stg/prd']).join(', ')})`;
}

// ---------------------------------------------------------------- commands

async function set(args: DopplerArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireCoordinatorDeployment(deps);
  const project = args.project ?? '';
  const progress = (line: string) => (args.json ? deps.stderr(line) : deps.stdout(line));
  const configs = args.allConfigs ? await listConfigs(deps, project) : args.configs;
  if (configs.length === 0) throw new Error(`Doppler project ${project} has no configs.`);

  const tokens: Array<{ project: string; config: string; content: string }> = [];
  const records: CoordinatorSecretsConfig[] = [];
  const setAt = new Date(deps.now()).toISOString();
  if (args.tokenFile) {
    const token = (await deps.readSecretFile(args.tokenFile)).trim();
    const refused = refusedToken(token);
    if (refused) throw new Error(refused);
    // A service token's access isn't visible from its text; one set mints is always read-only.
    deps.stderr('runpane cloud: installing a service token you made; runpane cannot check it is read-only, so make sure it was created with Access: read.');
    tokens.push({ project, config: configs[0], content: token });
    records.push({ project, config: configs[0], setAt });
  } else {
    const name = args.tokenName ?? `runpane-cloud-${deployment.hostname}`;
    progress(`runpane cloud: minting read-only Doppler service tokens "${name}" for ${configs.map((config) => `${project}/${config}`).join(', ')} with this machine's doppler CLI (not printed)...`);
    try {
      for (const config of configs) {
        const minted = await mintToken(deps, project, config, name);
        tokens.push({ project, config, content: minted.token });
        records.push({ project, config, tokenSlug: minted.slug, tokenName: name, setAt });
      }
    } catch (error) {
      // Nothing is installed unless every token was minted; revoke the ones that were.
      for (const record of records) await revokeToken(deps, record);
      throw error;
    }
  }

  const previous = deployment.secrets;
  const replaced = new Set(records.map((record) => `${record.project}/${record.config}`));
  const kept = (previous?.configs ?? []).filter((config) => !replaced.has(`${config.project}/${config.config}`));
  const next: CoordinatorDeployment = {
    ...deployment,
    secrets: {
      configs: [...kept, ...records],
      policy: args.policy ?? previous?.policy ?? { mode: 'default' },
    },
  };
  const apiBaseUrl = args.apiBaseUrl ?? previous?.apiBaseUrl;
  if (apiBaseUrl && next.secrets) next.secrets.apiBaseUrl = apiBaseUrl;

  progress(`runpane cloud: installing ${tokens.length} token${tokens.length === 1 ? '' : 's'} on the coordinator ${deployment.hostname} (0600) and restarting it...`);
  const { provider } = await loadCoordinatorProvider(deps);
  try {
    await reconfigureCoordinator(provider, next, { dopplerTokens: tokens });
  } catch (error) {
    for (const record of records) await revokeToken(deps, record);
    throw error;
  }
  await saveCoordinatorDeployment(deps, next);
  // Replaced tokens this machine minted are revoked in Doppler once the new ones are in place.
  const superseded = (previous?.configs ?? []).filter((config) => replaced.has(`${config.project}/${config.config}`) && config.tokenSlug);
  const revokeFailures = (await Promise.all(superseded.map((config) => revokeToken(deps, config)))).filter((failure): failure is string => failure !== null);

  const coordinator = await secretsStatus(deps, true);
  const failed = 'unavailable' in coordinator ? [] : (coordinator.configs ?? []).filter((config) => config.error !== undefined);
  const summary = {
    ok: !('unavailable' in coordinator) && failed.length === 0,
    configs: next.secrets?.configs.map((config) => `${config.project}/${config.config}`) ?? [],
    policy: next.secrets?.policy ?? null,
    coordinator: 'unavailable' in coordinator ? { unavailable: coordinator.unavailable } : coordinator,
    revokeFailures,
  };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`runpane cloud: the coordinator's Doppler secrets service is on for ${summary.configs.join(', ')}.`);
    deps.stdout(`  policy: ${describePolicy(next.secrets?.policy ?? { mode: 'default' })}`);
    if ('unavailable' in coordinator) deps.stdout(`  warning: could not ask the coordinator (${coordinator.unavailable}); check with runpane cloud coordinator doppler status --check.`);
    else for (const config of coordinator.configs ?? []) deps.stdout(`  ${config.project}/${config.config}: ${config.error ? `ERROR ${config.error}` : `${String(config.names ?? '?')} names readable`}`);
    for (const failure of revokeFailures) deps.stderr(`WARNING: ${failure}`);
    deps.stdout('  Sessions on a repository with .runpane/secrets.json get its names at creation and at every wake (doppler run -- ... inside them).');
  }
  return summary.ok ? 0 : 1;
}

async function policy(args: DopplerArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireCoordinatorDeployment(deps);
  if (!deployment.secrets) throw new Error('The coordinator has no Doppler secrets service yet: run runpane cloud coordinator doppler set first.');
  const nextPolicy = args.policy ?? { mode: 'default' };
  const next: CoordinatorDeployment = { ...deployment, secrets: { ...deployment.secrets, policy: nextPolicy } };
  const { provider } = await loadCoordinatorProvider(deps);
  await reconfigureCoordinator(provider, next);
  await saveCoordinatorDeployment(deps, next);
  if (args.json) deps.stdout(JSON.stringify({ ok: true, policy: nextPolicy }, null, 2));
  else deps.stdout(`runpane cloud: secrets policy on ${deployment.hostname}: ${describePolicy(nextPolicy)}. Sessions pick it up at their next refresh (wake, or doppler refresh).`);
  return 0;
}

async function status(args: DopplerArgs, deps: CloudDeps): Promise<number> {
  const deployment = await requireCoordinatorDeployment(deps);
  const coordinator = await secretsStatus(deps, args.check);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: !('unavailable' in coordinator), configured: deployment.secrets ?? null, coordinator }, null, 2));
    return 'unavailable' in coordinator ? 1 : 0;
  }
  if ('unavailable' in coordinator) {
    deps.stdout(`coordinator ${deployment.hostname}: ${coordinator.unavailable}.`);
    return 1;
  }
  if (!coordinator.enabled) {
    deps.stdout(`Doppler secrets on ${deployment.hostname}: off (runpane cloud coordinator doppler set --project <p> --config <c>).`);
    return 0;
  }
  deps.stdout(`Doppler secrets on ${deployment.hostname}: on`);
  deps.stdout(`  policy: ${describePolicy(deployment.secrets?.policy ?? { mode: 'default' })}`);
  for (const config of coordinator.configs ?? []) {
    const minted = deployment.secrets?.configs.find((candidate) => candidate.project === config.project && candidate.config === config.config);
    deps.stdout(`  ${config.project}/${config.config}: ${config.error ? `ERROR ${config.error}` : config.loaded ? `token loaded${config.names !== undefined ? `, ${config.names} names readable` : ''}` : 'no token'}${minted?.tokenName ? ` (service token "${minted.tokenName}")` : ''}`);
  }
  return 0;
}

async function audit(args: DopplerArgs, deps: CloudDeps): Promise<number> {
  await requireCoordinatorDeployment(deps);
  if (!deps.callCoordinatorApi) throw new Error('This build cannot call the coordinator API.');
  const result = await deps.callCoordinatorApi('GET', `/cloud/secrets/audit?limit=${args.limit}`, undefined, 60_000);
  if (result.status !== 200) throw new Error(`The coordinator answered ${result.status}${result.status === 404 ? ' (no secrets service: redeploy it)' : ''}.`);
  const { entries } = decodeBoundary(result.body, auditSchema);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, entries }, null, 2));
  } else if (entries.length === 0) {
    deps.stdout('No secrets fetches yet.');
  } else {
    for (const raw of entries) {
      const entry = decodeBoundary(raw, auditEntrySchema);
      const configs = (entry.configs ?? []).map((config) => `${config.config}:${config.refused ? 'refused' : `${config.delivered?.length ?? 0} names${config.withheld?.length ? ` (${config.withheld.length} withheld)` : ''}`}`).join(' ');
      deps.stdout(`${entry.at ?? '?'}  ${entry.label ?? entry.callerId ?? '?'}  ${entry.endpoint ?? '?'}  ${entry.repo ?? ''}${entry.ref ? `@${entry.ref}` : ''} ${entry.manifestSha ? entry.manifestSha.slice(0, 12) : ''}  ${entry.outcome ?? '?'}  ${configs}`);
    }
  }
  return 0;
}

async function unset(args: DopplerArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) throw new Error('runpane cloud coordinator doppler unset shreds the Doppler tokens on the coordinator (and revokes the ones this machine minted). Rerun with --yes to confirm.');
  const deployment = await requireCoordinatorDeployment(deps);
  const current = deployment.secrets?.configs ?? [];
  const removed = args.allConfigs ? current : current.filter((config) => args.configs.includes(config.config));
  const remaining = current.filter((config) => !removed.includes(config));
  const next: CoordinatorDeployment = { ...deployment };
  if (remaining.length > 0 && deployment.secrets) next.secrets = { ...deployment.secrets, configs: remaining };
  else delete next.secrets;
  const { provider } = await loadCoordinatorProvider(deps);
  await reconfigureCoordinator(provider, next, {
    removeDopplerTokens: remaining.length === 0 ? 'all' : removed.map((config) => ({ project: config.project, config: config.config })),
  });
  await saveCoordinatorDeployment(deps, next);
  const revokeFailures = args.keepTokens ? [] : (await Promise.all(removed.map((config) => revokeToken(deps, config)))).filter((failure): failure is string => failure !== null);
  const summary = { ok: revokeFailures.length === 0, removed: removed.map((config) => `${config.project}/${config.config}`), remaining: remaining.map((config) => `${config.project}/${config.config}`), revoked: !args.keepTokens, revokeFailures };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`runpane cloud: removed ${summary.removed.join(', ') || 'nothing'} from the coordinator ${deployment.hostname} (tokens shredded there)${remaining.length === 0 ? '; the secrets service is off' : ''}.`);
    if (!args.keepTokens) deps.stdout(`  Doppler: ${revokeFailures.length === 0 ? 'the service tokens this machine minted are revoked' : 'some tokens could not be revoked:'}`);
    for (const failure of revokeFailures) deps.stderr(`WARNING: ${failure}`);
    deps.stdout('  Sessions keep their last copy until their next refresh (wake or doppler refresh), which then clears it.');
  }
  return summary.ok ? 0 : 1;
}
