import { boundary, decodeBoundary } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { launcher } from './githubBroker';
import { SANDBOX_HOME, type SandboxHandle } from './provider';

/**
 * Laptop side of the coordinator's Doppler secrets (setup time only): installs the Session's `doppler`
 * stand-in (~/.local/bin/doppler -> runpane cloud agent doppler), a user unit that refreshes the set
 * from the coordinator at every boot (a boat wake is a boot), and a short note for agents; then asks
 * the Session to fetch once. Values go coordinator -> Session over the tailnet and never pass here:
 * the refresh prints names only.
 */

const LOCAL_BIN = `${SANDBOX_HOME}/.local/bin`;
const DOPPLER_PATH = `${LOCAL_BIN}/doppler`;
const UNIT_NAME = 'runpane-cloud-secrets.service';
const UNIT_PATH = `${SANDBOX_HOME}/.config/systemd/user/${UNIT_NAME}`;
const CACHE_DIR = `${SANDBOX_HOME}/.runpane-cloud/doppler`;
const NOTES_FILES = [`${SANDBOX_HOME}/.claude/CLAUDE.md`, `${SANDBOX_HOME}/.codex/AGENTS.md`];
const NOTES_START = '<!-- runpane-cloud-secrets:start -->';
const NOTES_END = '<!-- runpane-cloud-secrets:end -->';
const OK_MARKER = 'RP_DOPPLER';

function secretsAgentNotes(): string {
  return `${NOTES_START}
## Secrets (Doppler) in this runpane cloud Session

The repository's \`.runpane/secrets.json\` names which Doppler configs and names this Session gets; the runpane cloud coordinator delivers them (no Doppler login here).

- **Use them as the repo's docs say:** \`doppler run -- <command>\` (or \`doppler run -p <project> -c <config> -- ...\`) puts them in that command's environment only.
- **One value:** \`doppler secrets get NAME --plain\`. **Names:** \`doppler secrets --only-names\`. **Where from:** \`doppler status\`.
- **Refresh** after the manifest or Doppler changed: \`doppler refresh\` (it also refreshes at every wake).
- Never print, log, commit or paste secret values (in chat, PRs, issues or files).
${NOTES_END}`;
}

/** Writes the stand-in, the boot unit and the agent notes (idempotent), then fetches once. */
export function installSecretsToolsScript(): string {
  const unit = `[Unit]
Description=runpane cloud: refresh this Session's Doppler secrets from the coordinator (every boot and wake)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${DOPPLER_PATH} refresh --boot --quiet
TimeoutStartSec=240

[Install]
WantedBy=default.target
`;
  return `set -eu
umask 077
mkdir -p ${LOCAL_BIN} "$(dirname ${UNIT_PATH})" ${CACHE_DIR}
chmod 700 ${CACHE_DIR}
cat > ${DOPPLER_PATH} <<'RP_DOPPLER_SHIM'
${launcher('doppler for a runpane cloud Session: this repository\'s manifest secrets, delivered by the coordinator.', 'doppler', 'new / secrets enable')}RP_DOPPLER_SHIM
chmod 755 ${DOPPLER_PATH}
cat > ${UNIT_PATH} <<'RP_DOPPLER_UNIT'
${unit}RP_DOPPLER_UNIT
chmod 644 ${UNIT_PATH}
systemctl --user daemon-reload
systemctl --user enable ${UNIT_NAME} >/dev/null 2>&1
# Pane's daemon and non-login shells may not have ~/.local/bin first: link the stand-in into
# /usr/local/bin too, unless a real doppler (or anything else) already owns that name.
sysbin="\${RP_SYSTEM_BIN:-/usr/local/bin}"
as_root() { if [ -w "$sysbin" ]; then "$@"; else sudo -n "$@"; fi; }
if { [ ! -e "$sysbin/doppler" ] && [ ! -L "$sysbin/doppler" ]; } || [ "$(readlink "$sysbin/doppler" 2>/dev/null)" = ${DOPPLER_PATH} ]; then
  if as_root ln -sfn ${DOPPLER_PATH} "$sysbin/doppler" 2>/dev/null; then echo "${OK_MARKER}_SYSBIN linked"; else echo "${OK_MARKER}_SYSBIN no-sudo"; fi
else
  echo "${OK_MARKER}_SYSBIN occupied"
fi
python3 - <<'PY'
import os, re
def replace_block(path, start, end, block):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = open(path).read() if os.path.exists(path) else ''
    text = re.sub(re.escape(start) + r'.*?' + re.escape(end) + r'\\n?', '', text, flags=re.S)
    text = (text.rstrip('\\n') + '\\n\\n' if text.strip() else '') + block + '\\n'
    open(path, 'w').write(text)
for path in ${JSON.stringify(NOTES_FILES)}:
    replace_block(path, ${JSON.stringify(NOTES_START)}, ${JSON.stringify(NOTES_END)}, ${JSON.stringify(secretsAgentNotes())})
PY
if ! ${DOPPLER_PATH} --version 2>/dev/null | grep -q runpane-cloud-stand-in; then
  echo "${OK_MARKER}_OLD $("$HOME/.pane_remote/bin/runpane" --version 2>/dev/null | head -1)"
  exit 0
fi
# The first fetch: names only on stdout (the values go straight into the 0600 file).
if out=$(${DOPPLER_PATH} refresh --json 2>&1); then
  printf '%s %s\\n' "${OK_MARKER}_FETCH" "$(printf '%s' "$out" | tr -d '\\n')"
else
  printf '%s %s\\n' "${OK_MARKER}_FETCH_FAILED" "$(printf '%s' "$out" | tail -1)"
fi
`;
}

/** Removes the stand-in, the unit, the notes and the stored set (shredded); idempotent. */
export function removeSecretsToolsScript(): string {
  return `set -eu
systemctl --user disable ${UNIT_NAME} >/dev/null 2>&1 || true
rm -f ${UNIT_PATH}
systemctl --user daemon-reload || true
sysbin="\${RP_SYSTEM_BIN:-/usr/local/bin}"
if [ "$(readlink "$sysbin/doppler" 2>/dev/null)" = ${DOPPLER_PATH} ]; then
  if [ -w "$sysbin" ]; then rm -f "$sysbin/doppler"; else sudo -n rm -f "$sysbin/doppler" || true; fi
fi
rm -f ${DOPPLER_PATH}
if [ -d ${CACHE_DIR} ]; then find ${CACHE_DIR} -type f -exec shred -u {} + 2>/dev/null || true; rm -rf ${CACHE_DIR}; fi
python3 - <<'PY'
import os, re
for path in ${JSON.stringify(NOTES_FILES)}:
    if os.path.exists(path):
        text = open(path).read()
        new = re.sub(re.escape(${JSON.stringify(NOTES_START)}) + r'.*?' + re.escape(${JSON.stringify(NOTES_END)}) + r'\\n?', '', text, flags=re.S)
        if new != text:
            open(path, 'w').write(new)
PY
echo ${OK_MARKER}_REMOVED
`;
}

const fetchSummarySchema = boundary.object({
  source: boundary.optional(boundary.string),
  reason: boundary.optional(boundary.nullable(boundary.string)),
  version: boundary.optional(boundary.nullable(boundary.string)),
  configs: boundary.optional(boundary.array(boundary.object({
    config: boundary.string,
    names: boundary.array(boundary.string),
    withheld: boundary.optional(boundary.array(boundary.object({ name: boundary.string, reason: boundary.string }))),
    refused: boundary.optional(boundary.nullable(boundary.string)),
  }))),
});

export interface SecretsToolsOutcome {
  /** The stand-in answers (the Session's runpane has `cloud agent doppler`). */
  ready: boolean;
  /** What the first fetch delivered (names only), or why it failed. */
  fetched: { source: string; version: string | null; configs: Array<{ config: string; names: number; withheld: number; refused: string | null }>; reason: string | null } | null;
  fetchError: string | null;
  warning: string | null;
}

export async function enableSessionSecrets(handle: SandboxHandle, host: string): Promise<SecretsToolsOutcome> {
  const result = await handle.runScript(installSecretsToolsScript(), { timeoutSeconds: 120 });
  if (result.exitCode !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split('\n').filter((line) => !line.startsWith(`${OK_MARKER}_FETCH`)).slice(-2).join(' ');
    throw new Error(`Installing the doppler stand-in failed in the sandbox (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}`);
  }
  const lines = result.stdout.split('\n');
  const old = lines.find((line) => line.startsWith(`${OK_MARKER}_OLD`));
  if (old !== undefined) {
    const version = old.slice(`${OK_MARKER}_OLD`.length).trim();
    return {
      ready: false,
      fetched: null,
      fetchError: null,
      warning: `${host}'s Pane${version ? ` (${version})` : ''} predates the doppler stand-in, so doppler in the Session can't fetch yet. Give it a newer Pane (runpane cloud new --pane-deb-url with a build that has it); the unit is in place and starts working then.`,
    };
  }
  const fetched = lines.find((line) => line.startsWith(`${OK_MARKER}_FETCH `));
  if (fetched !== undefined) {
    const summary = decodeBoundary(JSON.parse(fetched.slice(`${OK_MARKER}_FETCH `.length)), fetchSummarySchema);
    return {
      ready: true,
      fetched: {
        source: summary.source ?? 'unknown',
        version: summary.version ?? null,
        reason: summary.reason ?? null,
        configs: (summary.configs ?? []).map((config) => ({ config: config.config, names: config.names.length, withheld: config.withheld?.length ?? 0, refused: config.refused ?? null })),
      },
      fetchError: null,
      warning: null,
    };
  }
  const failed = lines.find((line) => line.startsWith(`${OK_MARKER}_FETCH_FAILED`));
  return { ready: true, fetched: null, fetchError: failed?.slice(`${OK_MARKER}_FETCH_FAILED`.length).trim() || 'the first fetch did not report', warning: null };
}

export async function disableSessionSecrets(handle: SandboxHandle): Promise<void> {
  const result = await handle.runScript(removeSecretsToolsScript(), { timeoutSeconds: 60 });
  if (result.exitCode !== 0 || !result.stdout.includes(`${OK_MARKER}_REMOVED`)) {
    throw new Error(`Removing the doppler stand-in failed in the sandbox (exit ${String(result.exitCode)}): ${result.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
  }
}

/** Whether the coordinator's secrets service is on, as this machine's user caller sees it. */
export async function coordinatorSecretsEnabled(deps: CloudDeps): Promise<boolean> {
  if (!deps.callCoordinatorApi) return false;
  try {
    const result = await deps.callCoordinatorApi('GET', '/cloud/secrets/status', undefined, 30_000);
    return result.status === 200 && decodeBoundary(result.body, boundary.object({ enabled: boundary.optional(boundary.boolean) })).enabled === true;
  } catch {
    return false;
  }
}

/** One line for `new` and `secrets enable`. */
export function describeSecretsOutcome(outcome: SecretsToolsOutcome): string {
  if (!outcome.ready) return 'doppler stand-in installed; waiting for a newer Pane in the Session';
  if (outcome.fetchError) return `doppler stand-in installed; the first fetch failed: ${outcome.fetchError}`;
  const fetched = outcome.fetched;
  if (!fetched || fetched.configs.length === 0) return `doppler stand-in installed; no secrets (${fetched?.reason ?? 'no manifest'})`;
  return `doppler stand-in installed; ${fetched.configs.map((config) => `${config.config} ${config.refused ? 'refused' : `${config.names} names${config.withheld ? ` (${config.withheld} withheld by policy)` : ''}`}`).join(', ')} from ${fetched.source}`;
}
