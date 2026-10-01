import { boundary, decodeBoundary } from '../boundaryDecoder';
import { BUILT_IN_DENY_LIST, matchingPattern } from './secretPolicy';
import type { SandboxHandle } from './provider';

/**
 * `runpane cloud secrets inspect <host>`: what secrets a cloud Session holds, by name, and whether
 * their files are private. It covers every store a Session has: the agent secrets `cloud secrets set`
 * staged (~/.runpane-cloud/secrets.json and secrets.env), the agent sign-in (agent.env), the doppler
 * stand-in's copy (~/.runpane-cloud/doppler/secrets.json), the peers list with its coordinator token,
 * and the git credential tokens.
 *
 * The script reads names (JSON keys, `NAME=` prefixes) and file modes only; it never reads a value
 * into its output, so nothing but names, counts and modes leaves the sandbox. Any process running as
 * the Session user can read these 0600 files: that is the design (the agents need them), so a file is
 * flagged only when group or others can read it.
 */

const OK_MARKER = 'RP_SECRETS_INSPECT';
const SCRIPT_TIMEOUT_SECONDS = 60;

/** Paths relative to the Session user's home, with what they hold (never what is in them). */
const SECRET_PATHS: ReadonlyArray<{ path: string; holds: string }> = [
  { path: '.runpane-cloud', holds: 'runpane cloud state' },
  { path: '.runpane-cloud/secrets.json', holds: 'agent secrets (runpane cloud secrets set)' },
  { path: '.runpane-cloud/secrets.env', holds: 'agent secrets, as the panel shells load them' },
  { path: '.runpane-cloud/agent.env', holds: 'agent sign-in (Anthropic key or Claude token)' },
  { path: '.runpane-cloud/doppler', holds: 'doppler stand-in state' },
  { path: '.runpane-cloud/doppler/secrets.json', holds: 'Doppler secrets the coordinator delivered' },
  { path: '.config/runpane-cloud', holds: 'peers list' },
  { path: '.config/runpane-cloud/peers.json', holds: 'peer and coordinator tokens' },
  { path: '.config/runpane-cloud-git', holds: 'git credential tokens' },
  { path: '.claude.json', holds: 'Claude Code state (the end of an approved API key)' },
];

function inspectSecretsScript(): string {
  return `set -e
python3 - <<'PY'
import glob, json, os, re
home = os.path.expanduser('~')

def mode(path):
    try:
        return '0%03o' % (os.stat(path).st_mode & 0o777)
    except OSError:
        return None

def json_keys(path):
    # Keys only: the values are read by json.load but never copied out.
    try:
        data = json.load(open(path))
    except (OSError, ValueError):
        return None
    return sorted(data) if isinstance(data, dict) else None

def env_names(path):
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return None
    names = []
    for line in lines:
        match = re.match(r'^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=', line)
        if match:
            names.append(match.group(1))
    return sorted(set(names))

def doppler(path):
    try:
        data = json.load(open(path))
    except (OSError, ValueError):
        return None
    configs = []
    for config in data.get('configs') or []:
        values = config.get('values') or {}
        configs.append({
            'config': '%s/%s' % (config.get('project'), config.get('config')),
            'names': sorted(values) if isinstance(values, dict) else [],
            'withheld': sorted(item.get('name', '?') for item in config.get('withheld') or []),
            'missing': sorted(config.get('missing') or []),
            'refused': config.get('refused'),
        })
    return {'fetchedAt': data.get('fetchedAt'), 'storedAt': data.get('storedAt'), 'version': data.get('version'), 'reason': data.get('reason'), 'configs': configs}

files = []
for item in ${JSON.stringify(SECRET_PATHS)}:
    path = os.path.join(home, item['path'])
    files.append({'path': '~/' + item['path'], 'holds': item['holds'], 'mode': mode(path)})
for path in sorted(glob.glob(os.path.join(home, '.config/runpane-cloud-git/*.token'))):
    files.append({'path': '~/' + os.path.relpath(path, home), 'holds': 'a git credential token', 'mode': mode(path)})
staged = sorted(glob.glob(os.path.join(home, '.runpane-cloud/secrets.stage-*.json')))
for path in staged:
    files.append({'path': '~/' + os.path.relpath(path, home), 'holds': 'a staged secrets file left behind (should have been shredded)', 'mode': mode(path)})

store = os.path.join(home, '.runpane-cloud')
out = {
    'agentSecrets': json_keys(os.path.join(store, 'secrets.json')),
    'agentSignIn': env_names(os.path.join(store, 'agent.env')),
    'doppler': doppler(os.path.join(store, 'doppler', 'secrets.json')),
    'stagedLeftovers': len(staged),
    'files': files,
}
print(${JSON.stringify(OK_MARKER)} + ' ' + json.dumps(out))
PY
`;
}

const namesSchema = boundary.nullable(boundary.array(boundary.string));

const inspectSchema = boundary.object({
  agentSecrets: namesSchema,
  agentSignIn: namesSchema,
  doppler: boundary.nullable(boundary.object({
    fetchedAt: boundary.nullable(boundary.string),
    version: boundary.nullable(boundary.string),
    reason: boundary.nullable(boundary.string),
    configs: boundary.array(boundary.object({
      config: boundary.string,
      names: boundary.array(boundary.string),
      withheld: boundary.array(boundary.string),
      missing: boundary.array(boundary.string),
      refused: boundary.nullable(boundary.string),
    })),
  })),
  stagedLeftovers: boundary.number,
  files: boundary.array(boundary.object({ path: boundary.string, holds: boundary.string, mode: boundary.nullable(boundary.string) })),
});

interface SecretsInspection {
  agentSecrets: string[] | null;
  agentSignIn: string[] | null;
  doppler: {
    fetchedAt: string | null;
    version: string | null;
    reason: string | null;
    configs: Array<{ config: string; names: string[]; withheld: string[]; missing: string[]; refused: string | null }>;
  } | null;
  stagedLeftovers: number;
  files: Array<{ path: string; holds: string; mode: string | null }>;
}

/** A mode that lets group or others read or write the file. */
function exposed(mode: string | null): boolean {
  return mode !== null && (Number.parseInt(mode, 8) & 0o077) !== 0;
}

interface InspectOutput {
  stdout(text: string): void;
}

export async function runSecretsInspect(handle: SandboxHandle, host: string, options: { json: boolean; userDenyList: readonly string[] }, out: InspectOutput): Promise<number> {
  const result = await handle.runScript(inspectSecretsScript(), { timeoutSeconds: SCRIPT_TIMEOUT_SECONDS });
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(`${OK_MARKER} `));
  if (result.exitCode !== 0 || !line) {
    // The script prints names and modes only, so its last stderr line (a Python traceback, at worst) is safe to show.
    const detail = result.stderr.trim().split('\n').slice(-1)[0] ?? '';
    throw new Error(`Inspecting the secrets failed in the sandbox (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}.`);
  }
  const inspection: SecretsInspection = decodeBoundary(JSON.parse(line.slice(OK_MARKER.length + 1)), inspectSchema);
  const exposedFiles = inspection.files.filter((file) => exposed(file.mode)).map((file) => file.path);
  const denied = (inspection.agentSecrets ?? []).filter((name) => matchingPattern(name, [...BUILT_IN_DENY_LIST, ...options.userDenyList]) !== null);
  const ok = exposedFiles.length === 0 && inspection.stagedLeftovers === 0;
  if (options.json) {
    out.stdout(JSON.stringify({ ok, host, ...inspection, exposed: exposedFiles, denied }, null, 2));
    return ok ? 0 : 1;
  }
  for (const text of describeInspection(host, inspection, exposedFiles, denied)) out.stdout(text);
  return ok ? 0 : 1;
}

function describeInspection(host: string, inspection: SecretsInspection, exposedFiles: readonly string[], denied: readonly string[]): string[] {
  const names = (list: readonly string[]) => (list.length === 0 ? 'none' : `${list.length} (${list.join(', ')})`);
  const lines = [`${host} secrets (names and modes only; values never leave the Session):`];
  lines.push(`  agent secrets (runpane cloud secrets set): ${inspection.agentSecrets === null ? 'none stored' : names(inspection.agentSecrets)}`);
  if (denied.length > 0) lines.push(`    now on the deny-list: ${denied.join(', ')} (remove with runpane cloud secrets rm)`);
  lines.push(`  agent sign-in: ${inspection.agentSignIn === null ? 'none stored' : names(inspection.agentSignIn)}`);
  const doppler = inspection.doppler;
  if (doppler === null) lines.push('  doppler stand-in: nothing fetched (runpane cloud secrets enable, then doppler refresh in the Session)');
  else {
    lines.push(`  doppler stand-in: fetched ${doppler.fetchedAt ?? '?'}, version ${doppler.version ?? 'none'}${doppler.reason ? `; ${doppler.reason}` : ''}`);
    for (const config of doppler.configs) {
      lines.push(`    ${config.config}: ${config.refused ? `refused: ${config.refused}` : names(config.names)}`
        + `${config.withheld.length > 0 ? `; withheld ${config.withheld.join(', ')}` : ''}${config.missing.length > 0 ? `; not in Doppler ${config.missing.join(', ')}` : ''}`);
    }
  }
  lines.push('  files (any process running as the Session user can read 0600 files; that is by design):');
  for (const file of inspection.files) {
    if (file.mode === null) continue;
    lines.push(`    ${file.mode}  ${file.path}  ${file.holds}${exposedFiles.includes(file.path) ? '   WARNING: group or others can read it (chmod go-rwx)' : ''}`);
  }
  if (inspection.stagedLeftovers > 0) lines.push(`  WARNING: ${inspection.stagedLeftovers} staged secrets file(s) were not shredded; rerun runpane cloud secrets set or shred them in the Session.`);
  return lines;
}
