import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAppDirectory } from '../../utils/appDirectory';
import { getShellPath } from '../../utils/shellPath';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';

const execFileAsync = promisify(execFile);
export const CLAUDE_ADAPTER_VERSION = '0.94.0';
const CODEX_ADAPTER_VERSION = '2.2.2';
type Provider = 'claude' | 'codex';
const adapters = { claude: { packageName: '@agentclientprotocol/claude-agent-acp', version: CLAUDE_ADAPTER_VERSION }, codex: { packageName: '@agentclientprotocol/codex-acp', version: CODEX_ADAPTER_VERSION } };
const installations = new Map<Provider, Promise<void>>();

function directory(provider: Provider): string { return path.join(getAppDirectory(), 'agent-adapters', `${provider}-${adapters[provider].version}`); }

export function adapterEntry(provider: Provider): string | undefined {
  const { packageName, version } = adapters[provider];
  const root = path.join(directory(provider), 'node_modules', packageName);
  if (!existsSync(path.join(root, 'package.json'))) return;
  let metadata;
  try { metadata = decodeOptionalBoundary(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ version: boundary.string })); }
  catch { return; }
  const entry = path.join(root, 'dist', 'index.js');
  return metadata?.version === version && existsSync(entry) ? entry : undefined;
}

export async function installClaudeAdapter(): Promise<void> { return installAdapter('claude'); }

/** Host-local setup, shared by simultaneous viewers. Never changes global packages or login. */
export async function installAdapter(provider: Provider): Promise<void> {
  if (adapterEntry(provider)) return;
  const pending = installations.get(provider);
  if (pending) return pending;
  const installation = (async () => {
    const { packageName, version } = adapters[provider];
    const npm = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
    const cwd = directory(provider);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    try { await execFileAsync(process.execPath, [npm, 'install', '--prefix', cwd, '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', `${packageName}@${version}`], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: getShellPath() }, timeout: 180_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    }); } catch (error) {
      throw new PaneError('CHAT_ADAPTER_INSTALL_FAILED', `Chat setup could not install the pinned adapter: ${error instanceof Error ? error.message : String(error)}`, 'Check npm and network access, then retry Chat setup. The terminal remains available.');
    }
    if (!adapterEntry(provider)) throw new PaneError('CHAT_ADAPTER_INSTALL_FAILED', 'The pinned adapter was not present after setup.', 'Inspect the npm installation error and retry setup.');
  })().finally(() => { installations.delete(provider); });
  installations.set(provider, installation);
  return installation;
}
