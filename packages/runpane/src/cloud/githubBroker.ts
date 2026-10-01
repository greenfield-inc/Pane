import type { JsonObject } from '../boundaryDecoder';
import { decodeBrokerStatus } from './agent/brokerClient';
import type { CloudDeps } from './commands';
import { pushDirectory, type CoordinatorPushResult } from './coordinatorSync';
import { pushPeersFile } from './peers';
import type { SandboxHandle } from './provider';
import type { CloudHostRecord } from './store';

/**
 * Laptop side of the coordinator's GitHub broker (setup time only): which repositories
 * a Session may publish to (the directory's `github.repos`), and the Session-side tools that talk to the
 * broker: `~/.local/bin/gh` (the gh shim), `~/.local/bin/git-credential-runpane` (App mode: read-only
 * fetch without a deploy key) and a short section in the agents' global instructions. No secret moves:
 * the Session calls the coordinator with its own caller token from its peers list.
 */

export const SANDBOX_HOME = '/home/user';
const LOCAL_BIN = `${SANDBOX_HOME}/.local/bin`;
const GH_SHIM_PATH = `${LOCAL_BIN}/gh`;
const GIT_CREDENTIAL_HELPER_PATH = `${LOCAL_BIN}/git-credential-runpane`;
const NOTES_FILES = [`${SANDBOX_HOME}/.claude/CLAUDE.md`, `${SANDBOX_HOME}/.codex/AGENTS.md`];
const NOTES_START = '<!-- runpane-cloud-github:start -->';
const NOTES_END = '<!-- runpane-cloud-github:end -->';
const PATH_START = '# runpane-cloud-github:start';
const PATH_END = '# runpane-cloud-github:end';
const GITHUB_URL = 'https://github.com';

type BrokerMode = 'app' | 'pat' | 'off';

/** What a Session's tools are set up for: its broker repositories and the broker's credential kind. */
interface BrokerTools {
  repos: string[];
  mode: 'app' | 'pat';
}

export interface CoordinatorGitHubStatus {
  mode: BrokerMode;
  app: string | null;
  /** Repositories the broker's credential reaches (empty: it did not say). */
  repos: string[];
}

/** The coordinator's broker, asked as this machine's user caller; a reason string when it can't be asked. */
export async function readBrokerStatus(deps: CloudDeps): Promise<CoordinatorGitHubStatus | { unavailable: string }> {
  if (!deps.callCoordinatorApi) return { unavailable: 'this build cannot call the coordinator API' };
  try {
    const result = await deps.callCoordinatorApi('GET', '/cloud/github/status', undefined, 60_000);
    if (result.status === 404) return { unavailable: 'the coordinator has no GitHub broker yet (redeploy it: runpane cloud coordinator deploy --yes)' };
    if (result.status < 200 || result.status >= 300) return { unavailable: `the coordinator answered HTTP ${result.status}` };
    const status = decodeBrokerStatus(result.body);
    return { mode: status.mode, app: status.app, repos: status.repos };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message.replace(/\.$/u, '') : String(error) };
  }
}

/** Whether the broker's credential reaches `repo` (case-insensitive); an empty list means it did not say. */
export function brokerReaches(status: CoordinatorGitHubStatus, repo: string): boolean {
  return status.repos.length === 0 || status.repos.some((candidate) => candidate.toLowerCase() === repo.toLowerCase());
}

function shq(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** A launcher that runs `runpane cloud agent <verb>` with the Session's Pane-managed runpane. */
export function launcher(comment: string, verb: string, installedBy = 'github connect --broker / new --github'): string {
  const name = verb === 'git-credential' ? 'git-credential-runpane' : verb;
  return `#!/bin/sh
# ${comment}
# Installed by runpane cloud (${installedBy}); it holds no credential.
for rp in "\${PANE_RUNPANE_BIN:-}" "$HOME/.pane_remote/bin/runpane" "$HOME/.pane/bin/runpane"; do
  if [ -n "$rp" ] && [ -x "$rp" ]; then exec "$rp" cloud agent ${verb} "$@"; fi
done
if command -v runpane >/dev/null 2>&1; then exec runpane cloud agent ${verb} "$@"; fi
echo "${name}: runpane is not installed in this Session" >&2
exit 1
`;
}

export function agentNotes(repos: readonly string[]): string {
  return `${NOTES_START}
## GitHub from this runpane cloud Session

This Session has no GitHub write credential. Work reaches GitHub through the runpane cloud coordinator:

- **Push:** commit, then \`runpane cloud agent github push\` (the current branch). It lands on GitHub as \`cloud/<this host>/<branch>\`. Plain \`git push\` to GitHub fails here on purpose.
- **Pull request:** \`gh pr create --title "..." --body "..."\` pushes the branch, then opens it. Pull requests are always **drafts**; a person marks them ready and merges.
- **Issues and comments:** \`gh issue create|comment|close|view|list\`, \`gh pr comment|edit|close|view|list\`.
- **\`master\`/\`main\` (the default branch) is off-limits:** never push to it or merge into it; the coordinator refuses.
- Other gh commands (\`gh api\`, merge, review, release, ...) are not available and exit 2. See \`runpane cloud agent github --help\`.

Repositories: ${repos.join(', ')}
${NOTES_END}`;
}

/** Writes the shim, the helper (App mode), the PATH guard and the agent notes; idempotent. */
export function installBrokerToolsScript(grant: BrokerTools): string {
  const helperConfig = grant.mode === 'app' ? `
git config --global --unset-all ${shq(`credential.${GITHUB_URL}.helper`)} || true
git config --global --add ${shq(`credential.${GITHUB_URL}.helper`)} ''
git config --global --add ${shq(`credential.${GITHUB_URL}.helper`)} ${GIT_CREDENTIAL_HELPER_PATH}
git config --global ${shq(`credential.${GITHUB_URL}.useHttpPath`)} true` : `
rm -f ${GIT_CREDENTIAL_HELPER_PATH}
git config --global --remove-section ${shq(`credential.${GITHUB_URL}`)} 2>/dev/null || true`;
  return `set -eu
mkdir -p ${LOCAL_BIN}
cat > ${GH_SHIM_PATH} <<'RP_GH'
${launcher('gh for a runpane cloud Session: pr/issue/auth status through the coordinator\'s GitHub broker; everything else exits 2.', 'gh')}RP_GH
chmod 755 ${GH_SHIM_PATH}
${grant.mode === 'app' ? `cat > ${GIT_CREDENTIAL_HELPER_PATH} <<'RP_CRED'
${launcher('git credential helper: a read-only, one-repository token from the coordinator\'s GitHub broker.', 'git-credential')}RP_CRED
chmod 755 ${GIT_CREDENTIAL_HELPER_PATH}` : ''}${helperConfig}
python3 - <<'PY'
import os, re
home = ${JSON.stringify(SANDBOX_HOME)}
def replace_block(path, start, end, block, create, top=False):
    if not os.path.exists(path) and not create:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = open(path).read() if os.path.exists(path) else ''
    pattern = re.compile(re.escape(start) + r'.*?' + re.escape(end) + r'\\n?', re.S)
    text = pattern.sub('', text)
    if block and top:
        text = block + '\\n' + text
    elif block:
        text = (text.rstrip('\\n') + '\\n\\n' if text.strip() else '') + block + '\\n'
    open(path, 'w').write(text)
notes = ${JSON.stringify(agentNotes(grant.repos))}
for path in ${JSON.stringify(NOTES_FILES)}:
    replace_block(path, ${JSON.stringify(NOTES_START)}, ${JSON.stringify(NOTES_END)}, notes, True)
# ~/.local/bin first, so the shim wins over any real gh on the image. At the TOP of the file: Ubuntu's
# .bashrc returns early for non-interactive shells, and Pane's own PATH probe sources it non-interactively.
guard = ${JSON.stringify(`${PATH_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${PATH_END}`)}
for name in ('.bashrc', '.profile', '.zshrc'):
    replace_block(os.path.join(home, name), ${JSON.stringify(PATH_START)}, ${JSON.stringify(PATH_END)}, guard, name != '.zshrc', True)
PY
# Pane's daemon runs gh with the PATH it probed once at start (/etc/environment's, /usr/local/bin before
# /usr/bin): link the shim there too, unless something else already owns that name.
sysbin="\${RP_SYSTEM_BIN:-/usr/local/bin}"
as_root() { if [ -w "$sysbin" ]; then "$@"; else sudo -n "$@"; fi; }
if [ ! -e "$sysbin/gh" ] && [ ! -L "$sysbin/gh" ] || [ "$(readlink "$sysbin/gh" 2>/dev/null)" = ${GH_SHIM_PATH} ]; then
  if as_root ln -sfn ${GH_SHIM_PATH} "$sysbin/gh" 2>/dev/null; then echo "RP_SYSGH linked"; else echo "RP_SYSGH no-sudo"; fi
else
  echo "RP_SYSGH occupied"
fi
# The shim needs a Pane whose bundled runpane has \`cloud agent\` (older builds answer "Unknown cloud command").
if "${GH_SHIM_PATH}" --version 2>/dev/null | grep -q runpane-cloud-shim; then
  echo "RP_SHIM ready"
else
  echo "RP_SHIM old $("$HOME/.pane_remote/bin/runpane" --version 2>/dev/null | head -1)"
fi
echo RP_OK broker-tools
`;
}

/** Removes everything installBrokerToolsScript wrote; idempotent. */
export function removeBrokerToolsScript(): string {
  return `set -eu
sysbin="\${RP_SYSTEM_BIN:-/usr/local/bin}"
if [ "$(readlink "$sysbin/gh" 2>/dev/null)" = ${GH_SHIM_PATH} ]; then
  if [ -w "$sysbin" ]; then rm -f "$sysbin/gh"; else sudo -n rm -f "$sysbin/gh" || true; fi
fi
rm -f ${GH_SHIM_PATH} ${GIT_CREDENTIAL_HELPER_PATH}
if [ "$(git config --global --get-all ${shq(`credential.${GITHUB_URL}.helper`)} 2>/dev/null | tail -1)" = ${GIT_CREDENTIAL_HELPER_PATH} ]; then
  git config --global --remove-section ${shq(`credential.${GITHUB_URL}`)} 2>/dev/null || true
fi
python3 - <<'PY'
import os, re
for path, start, end in ${JSON.stringify([
    ...NOTES_FILES.map((file) => [file, NOTES_START, NOTES_END]),
    ...['.bashrc', '.profile', '.zshrc'].map((name) => [`${SANDBOX_HOME}/${name}`, PATH_START, PATH_END]),
  ])}:
    if os.path.exists(path):
        text = open(path).read()
        new = re.sub(re.escape(start) + r'.*?' + re.escape(end) + r'\\n?', '', text, flags=re.S)
        if new != text:
            open(path, 'w').write(new)
PY
echo RP_OK broker-tools-removed
`;
}

/** Clones (or fetches) `repo` over https with the helper: App mode's replacement for the deploy-key clone. */
export function brokerCloneScript(repo: string, ref: string | undefined, dir: string): string {
  const url = `${GITHUB_URL}/${repo}.git`;
  return `set -eu
if [ -d ${shq(`${dir}/.git`)} ]; then
  cd ${shq(dir)} && GIT_TERMINAL_PROMPT=0 git fetch --quiet origin
else
  GIT_TERMINAL_PROMPT=0 git clone --quiet ${shq(url)} ${shq(dir)}
  cd ${shq(dir)}
fi
${ref ? `git checkout --quiet ${shq(ref)}` : ''}
printf 'RP_HEAD %s\\n' "$(git rev-parse HEAD)"
`;
}

async function runChecked(handle: SandboxHandle, script: string, what: string, timeoutSeconds = 120): Promise<string> {
  const result = await handle.runScript(script, { timeoutSeconds });
  if (result.exitCode !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-3).join(' ');
    throw new Error(`${what} failed in the sandbox (exit ${String(result.exitCode)})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

interface BrokerEnableResult {
  grant: BrokerTools;
  directory: CoordinatorPushResult;
  peersFile: JsonObject;
  /** Null when the Session's runpane has `cloud agent`; else what to tell the user. */
  shimWarning: string | null;
}

/**
 * Adds `repo` to the Session's broker grant, syncs the directory (so the coordinator allows it) and the
 * peers list (so the Session can reach the coordinator), then installs the Session-side tools.
 */
export async function enableBroker(
  record: CloudHostRecord,
  handle: SandboxHandle,
  deps: CloudDeps,
  options: { repo: string; mode: 'app' | 'pat' },
): Promise<BrokerEnableResult> {
  const repos = [...(record.meta.brokerRepos ?? []).filter((candidate) => candidate.toLowerCase() !== options.repo.toLowerCase()), options.repo];
  const grant: BrokerTools = { repos, mode: options.mode };
  record.meta.brokerRepos = repos;
  record.meta.brokerMode = options.mode;
  await deps.store.writeHost(record);
  const directory = await pushDirectory(deps);
  const peers = await pushPeersFile(record, await deps.store.listHosts(), deps);
  const stdout = await runChecked(handle, installBrokerToolsScript(grant), 'Installing the gh shim');
  const shim = /^RP_SHIM (ready|old)(.*)$/mu.exec(stdout);
  const shimWarning = shim?.[1] === 'old'
    ? `${record.profile.cloud.hostname}'s Pane${shim[2].trim() ? ` (${shim[2].trim()})` : ''} predates \`runpane cloud agent\`, so gh in the Session can't reach the broker yet. `
      + 'Give it a newer Pane (a newer golden image, or runpane cloud new --pane-deb-url with a build that has it); the grant is in place and starts working then.'
    : null;
  return { grant, directory, peersFile: peers.written ? { written: true } : { written: false, reason: peers.reason }, shimWarning };
}

/** Drops `repo` from the grant (all of them when it was the last) and removes the tools when none is left. */
export async function disableBroker(record: CloudHostRecord, handle: SandboxHandle | null, deps: CloudDeps, repo: string): Promise<{ remaining: string[]; directory: CoordinatorPushResult; toolsRemoved: boolean }> {
  const remaining = (record.meta.brokerRepos ?? []).filter((candidate) => candidate.toLowerCase() !== repo.toLowerCase());
  const mode = record.meta.brokerMode ?? 'app';
  if (remaining.length > 0) {
    record.meta.brokerRepos = remaining;
  } else {
    delete record.meta.brokerRepos;
    delete record.meta.brokerMode;
  }
  await deps.store.writeHost(record);
  const directory = await pushDirectory(deps);
  let toolsRemoved = false;
  if (handle) {
    await runChecked(handle, remaining.length > 0 ? installBrokerToolsScript({ repos: remaining, mode }) : removeBrokerToolsScript(), 'Updating the gh shim');
    toolsRemoved = remaining.length === 0;
  }
  return { remaining, directory, toolsRemoved };
}
