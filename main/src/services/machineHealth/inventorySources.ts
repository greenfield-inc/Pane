import { execFile } from 'child_process';
import { readdir, readlink, stat } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { agentConfig, CONFIGURED_AGENT_IDS } from '../../../../shared/agents';
import { readUpdateJournal } from '../../../../packages/runpane/src/updateOperation';
import type { UpdateRecord } from './reclaimRules';
import type { OtherToolPath } from './storageInventory';
import type { CommandRunner } from '../../utils/commandRunner';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

/** Every configured agent's per-session temp folders on this machine; PANE_AGENT_TEMP_DIRS (path-list) replaces them for isolated test instances. */
export function agentTempRoots(platform: NodeJS.Platform = process.platform): string[] {
  const override = process.env.PANE_AGENT_TEMP_DIRS;
  if (override !== undefined) return override.split(path.delimiter).filter(Boolean);
  const tmp = platform === 'win32' ? os.tmpdir() : '/tmp';
  const uid = platform === 'win32' ? '' : String(os.userInfo().uid);
  return CONFIGURED_AGENT_IDS.flatMap(id => agentConfig(id)?.tempDirs ?? [])
    .map(template => path.normalize(template.replace('{tmp}', tmp).replace('{uid}', uid)));
}

/** Updates recorded under `<paneDir>/updates`; a folder with no readable journal is left out, so it is never removed. */
export async function readUpdateRecords(paneDir: string): Promise<UpdateRecord[]> {
  const root = path.join(paneDir, 'updates');
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const records: UpdateRecord[] = [];
  for (const id of names) {
    try {
      const journal = readUpdateJournal(path.join(root, id, 'status.json'));
      records.push({ id, phase: journal.phase, updatedAt: Date.parse(journal.updatedAt) });
    } catch {
      // Not an update folder, or one still being written.
    }
  }
  return records;
}

/** Folders git ignores in a worktree (build outputs, dependencies), relative and `/`-separated. Runs through the project's runner, so WSL works. */
export async function ignoredDirs(worktreePath: string, runner: CommandRunner): Promise<string[]> {
  const { stdout } = await runner.execFile('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], worktreePath,
    { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, silent: true });
  return stdout.split('\0').filter(entry => entry.endsWith('/'));
}

/**
 * Working directories of this user's processes, or null when the list could not be read (an lsof error or
 * timeout). Windows reports none: a delete there fails while a Windows process holds the folder (WSL
 * paths are covered by isWslPath).
 */
export async function processCwds(): Promise<string[] | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fn', '-u', String(os.userInfo().uid)], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    }
    if (process.platform === 'linux') {
      const cwds = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/u.test(name))
        .map(pid => readlink(`/proc/${pid}/cwd`).catch(() => '')));
      return cwds.filter(Boolean);
    }
  } catch {
    return null;
  }
  return [];
}

/** Other tools' data: shown with its owner and the command that frees it, never deleted by Pane. */
export function otherToolPaths(platform: NodeJS.Platform = process.platform): OtherToolPath[] {
  const home = os.homedir();
  const tools: OtherToolPath[] = CONFIGURED_AGENT_IDS.flatMap(id => {
    const config = agentConfig(id);
    const dir = config?.terminal.configDir;
    return config && dir ? [{ path: path.join(home, dir), owner: `${config.label} data: transcripts, caches and settings.`, howToFree: `Use ${config.label}'s own cleanup settings; Pane does not delete it.` }] : [];
  });
  tools.push({ path: path.join(home, '.npm'), owner: 'npm cache.', howToFree: 'npm cache clean --force' });
  const pnpmStore = platform === 'darwin' ? path.join(home, 'Library', 'pnpm', 'store')
    : platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'pnpm', 'store')
      : path.join(home, '.local', 'share', 'pnpm', 'store');
  tools.push({ path: pnpmStore, owner: 'pnpm store, shared by every project.', howToFree: 'pnpm store prune' });
  if (platform === 'darwin') {
    tools.push({ path: path.join(home, 'Library', 'Developer', 'CoreSimulator'), owner: 'Xcode simulators.', howToFree: 'xcrun simctl delete unavailable' });
  }
  return tools;
}

/** WSL disk images (ext4.vhdx): shown with their size; shrinking them is manual. */
export async function wslDiskImages(): Promise<OtherToolPath[]> {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const found: OtherToolPath[] = [];
  const howToFree = 'Run wsl --shutdown, then compact the disk as Microsoft documents (Optimize-VHD or diskpart compact vdisk). Pane never runs these steps.';
  for (const parent of [path.join(local, 'Packages'), path.join(local, 'wsl')]) {
    let names: string[] = [];
    try {
      names = await readdir(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      for (const candidate of [path.join(parent, name, 'LocalState', 'ext4.vhdx'), path.join(parent, name, 'ext4.vhdx')]) {
        try {
          if ((await stat(candidate)).isFile()) found.push({ path: candidate, owner: 'WSL disk image.', howToFree });
        } catch {
          // Not a WSL package.
        }
      }
    }
  }
  return found;
}

/** The installed app bundle or folder, whose `.before-<update id>` copies sit beside it; null for a dev build. */
export function installPathOf(execPath: string, packaged: boolean, platform: NodeJS.Platform = process.platform): string | null {
  if (!packaged) return null;
  if (platform === 'darwin') {
    const bundle = execPath.split(`${path.sep}Contents${path.sep}MacOS${path.sep}`)[0];
    return bundle.endsWith('.app') ? bundle : null;
  }
  return process.env.APPIMAGE ?? path.dirname(execPath);
}
