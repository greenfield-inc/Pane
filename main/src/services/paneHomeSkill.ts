import { constants } from 'fs';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { getAppDirectory } from '../utils/appDirectory';
import { linuxToUNCPath } from '../utils/wslUtils';

/**
 * A user-level skill that teaches any agent in a Pane terminal how to reach
 * RunPane. It lives in the user's home skill folders (like Superset's) instead
 * of repository AGENTS.md files, so Pane never edits a user's repo to be found.
 * Only files carrying this marker are Pane's; everything else is left alone.
 */
export const PANE_MANAGED_SKILL_MARKER = '<!-- pane-managed-skill v1 -->';
const SKILL_DIR_NAME = 'pane';
const SKILL_FILE = 'SKILL.md';
const execFileAsync = promisify(execFile);
let syncQueue: Promise<void> = Promise.resolve();

type PaneHomeSkillOutcome = 'written' | 'unchanged' | 'removed' | 'absent' | 'user-owned' | 'unsafe';

export interface PaneHomeSkillResult {
  skillPath: string;
  outcome: PaneHomeSkillOutcome;
}

export function isPaneHomeSkillEnabled(config: Pick<AppConfig, 'agentContext'>): boolean {
  return config.agentContext?.homeSkill !== false;
}

/**
 * Claude reads user skills from its config directory (CLAUDE_CONFIG_DIR when
 * set); Codex and other agents read ~/.agents/skills, which is where Superset
 * installs for them too.
 */
export function paneHomeSkillDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const claudeRoot = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  return [
    path.join(claudeRoot, 'skills', SKILL_DIR_NAME),
    path.join(home, '.agents', 'skills', SKILL_DIR_NAME),
  ];
}

export function paneWslHomeSkillDirs(distro: string, home: string, claudeConfigDir = path.posix.join(home, '.claude')): string[] {
  return [
    linuxToUNCPath(path.posix.join(claudeConfigDir, 'skills', SKILL_DIR_NAME), distro),
    linuxToUNCPath(path.posix.join(home, '.agents', 'skills', SKILL_DIR_NAME), distro),
  ];
}

async function resolveWslHomeSkillDirs(distro: string): Promise<string[]> {
  const { stdout } = await execFileAsync('wsl.exe', [
    '-d', distro, '--', 'bash', '-lc',
    'printf "%s\\n%s\\n" "$HOME" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const [home, claudeConfigDir] = stdout.trim().split(/\r?\n/).map(value => value.trim());
  if (!home?.startsWith('/') || !claudeConfigDir?.startsWith('/')) {
    throw new Error(`Could not resolve skill directories in WSL distro ${distro}`);
  }
  return paneWslHomeSkillDirs(distro, home, claudeConfigDir);
}

function wslDistroRecordPath(): string {
  return path.join(getAppDirectory(), 'skills', 'wsl-distros.json');
}

async function readWslDistroRecord(): Promise<string[]> {
  try {
    return decodeBoundary(JSON.parse(await fs.readFile(wslDistroRecordPath(), 'utf8')), boundary.array(boundary.string));
  } catch {
    return [];
  }
}

async function writeWslDistroRecord(distros: string[]): Promise<void> {
  const recordPath = wslDistroRecordPath();
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, `${JSON.stringify(distros)}\n`, 'utf8');
}

export function syncPaneHomeSkill(
  config: Pick<AppConfig, 'agentContext'>,
  dirs: string[] = paneHomeSkillDirs(),
  wslDistros: string[] = [],
): Promise<PaneHomeSkillResult[]> {
  const result = syncQueue.then(() => syncPaneHomeSkillNow(config, dirs, wslDistros));
  syncQueue = result.then(() => {}, () => {});
  return result;
}

async function syncPaneHomeSkillNow(
  config: Pick<AppConfig, 'agentContext'>,
  dirs: string[],
  wslDistros: string[],
): Promise<PaneHomeSkillResult[]> {
  const enabled = isPaneHomeSkillEnabled(config);
  const results = enabled ? await installPaneHomeSkill(dirs) : await removePaneHomeSkill(dirs);
  if (process.platform !== 'win32') return results;

  const recorded = await readWslDistroRecord();
  const distros = [...new Set(enabled ? wslDistros : [...recorded, ...wslDistros])];
  if (enabled) await writeWslDistroRecord([...new Set([...recorded, ...wslDistros])]);
  const failed: string[] = [];
  for (const distro of distros) {
    try {
      const wslDirs = await resolveWslHomeSkillDirs(distro);
      results.push(...(enabled ? await installPaneHomeSkill(wslDirs) : await removePaneHomeSkill(wslDirs)));
    } catch (error) {
      failed.push(distro);
      console.warn(`[PaneHomeSkill] Could not sync skill in WSL distro ${distro}:`, error);
    }
  }
  if (!enabled) await writeWslDistroRecord(failed);
  return results;
}

export async function installPaneHomeSkill(dirs: string[] = paneHomeSkillDirs()): Promise<PaneHomeSkillResult[]> {
  const content = buildPaneHomeSkill();
  const results: PaneHomeSkillResult[] = [];
  for (const dir of dirs) {
    const skillPath = path.join(dir, SKILL_FILE);
    const dirKind = await entryKind(dir);
    if (dirKind === 'other') {
      results.push({ skillPath, outcome: 'unsafe' });
      continue;
    }
    if (dirKind === 'directory') {
      const existing = await readManagedFile(skillPath);
      if (existing.kind !== 'managed' && existing.kind !== 'missing') {
        results.push({ skillPath, outcome: existing.kind });
        continue;
      }
      // An existing folder without our marked file belongs to the user,
      // even when it is empty.
      if (existing.kind === 'missing') {
        results.push({ skillPath, outcome: 'user-owned' });
        continue;
      }
      if (existing.kind === 'managed' && existing.content === content) {
        results.push({ skillPath, outcome: 'unchanged' });
        continue;
      }
    } else {
      await fs.mkdir(dir, { recursive: true });
    }
    await replaceFile(skillPath, content);
    results.push({ skillPath, outcome: 'written' });
  }
  return results;
}

export async function removePaneHomeSkill(dirs: string[] = paneHomeSkillDirs()): Promise<PaneHomeSkillResult[]> {
  const results: PaneHomeSkillResult[] = [];
  for (const dir of dirs) {
    const skillPath = path.join(dir, SKILL_FILE);
    const dirKind = await entryKind(dir);
    if (dirKind === 'missing') {
      results.push({ skillPath, outcome: 'absent' });
      continue;
    }
    if (dirKind === 'other') {
      results.push({ skillPath, outcome: 'unsafe' });
      continue;
    }
    const existing = await readManagedFile(skillPath);
    if (existing.kind === 'missing') {
      results.push({ skillPath, outcome: 'absent' });
      continue;
    }
    if (existing.kind !== 'managed') {
      results.push({ skillPath, outcome: existing.kind });
      continue;
    }
    await fs.unlink(skillPath);
    // Keep the folder if the user added anything next to our file.
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
    results.push({ skillPath, outcome: 'removed' });
  }
  return results;
}

async function entryKind(target: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    const stat = await fs.lstat(target);
    // A symlinked folder may point anywhere; never write through it.
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'other';
  } catch (error) {
    if (decodeErrorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

type ManagedFile =
  | { kind: 'missing' }
  | { kind: 'managed'; content: string }
  | { kind: 'user-owned' }
  | { kind: 'unsafe' };

async function readManagedFile(filePath: string): Promise<ManagedFile> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) return { kind: 'unsafe' };
  } catch (error) {
    if (decodeErrorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = decodeErrorCode(error);
    if (code === 'ENOENT') return { kind: 'missing' };
    // ELOOP: the file is a symlink.
    if (code === 'ELOOP') return { kind: 'unsafe' };
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'unsafe' };
    const content = await handle.readFile('utf8');
    return content.includes(PANE_MANAGED_SKILL_MARKER) ? { kind: 'managed', content } : { kind: 'user-owned' };
  } finally {
    await handle.close();
  }
}

/** Write beside the target and rename over it, so readers never see a partial file. */
async function replaceFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { mode: 0o644, flag: 'wx' });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/** Node's fs errors carry a string `code`; anything else has none. */
const decodeErrorCode = (error: Parameters<typeof decodeBoundary>[0]): string | undefined => {
  try {
    return decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
  } catch {
    return undefined;
  }
};

export function buildPaneHomeSkill(): string {
  return `---
name: pane
description: Use Pane from inside a Pane terminal (PANE_SESSION_ID is set) through the runpane CLI. Use when delegating work to agents in their own Panes and worktrees, showing a page or file when supported, reading or sending input to another panel, or coordinating Panes from a Session orchestrator.
---
${PANE_MANAGED_SKILL_MARKER}

# Pane

Pane runs agents in terminal panels grouped into Panes, each Pane with its own
worktree. Sessions are orchestrator conversations that own Panes. You drive all
of it through the \`runpane\` CLI.

## Establish the control surface

1. Check for \`runpane\` on PATH. If it is absent, use
   \`npx --yes runpane@latest\` in place of \`runpane\` in every command below.
2. Run \`runpane doctor --json\`, then \`runpane agent-context --json\`. For a
   command's exact schema, run \`runpane agent-context --command "<command>" --json\`.
3. If runpane cannot be reached or doctor fails, stop and tell the user what
   failed. Do not substitute raw \`git worktree\` checkouts or built-in
   subagents for work that belongs in a Pane, and do not invent commands.
   From WSL when Pane runs on Windows, use the Windows wrapper through
   PowerShell from a Windows directory, for example
   \`powershell.exe -NoProfile -Command 'Set-Location $env:TEMP; runpane doctor --json'\`.
   Use that form for subsequent commands too. A Linux wrapper cannot reach
   the Windows named-pipe daemon; a Windows-mounted shim can also fail in WSL.

## Common commands

- Find a repository: \`runpane repos list --json\`
- 1 feature = 1 worktree = 1 branch = 1 Pane; reviews, audits, fixes and QA for it are tabs in that Pane.
- First check whether the work's branch already has a Pane: \`runpane panes list --repo <repo> --json\`, matching the PR's head branch against \`git -C <worktreePath> branch --show-current\`. If it does, use the tab command below.
- Start work whose branch has no Pane yet in a new Pane:
  \`runpane panes create --repo <repo> --name <name> --agent <codex|claude|cursor> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json\`
- For work that already has a Pane (review, audit, fixes, QA), open a new agent tab in that Pane, never a new Pane:
  \`runpane panels create --pane <pane-id> --agent <codex|claude|cursor> --initial-input "<task>" --source agent --no-focus --wait-ready --yes --json\`
- When \`runpane agent-context --command "panels open" --json\` lists the
  command, show the user a page or file with
  \`runpane panels open --file <path> --source agent --yes --json\` or
  \`runpane panels open --url <url> --source agent --yes --json\`.
- Inspect a Pane: \`runpane panes list --json\`, \`runpane panels list --pane <pane-id> --json\`
- Read or wait on a panel: \`runpane panels screen --panel <panel-id> --limit 80 --json\`,
  \`runpane panels wait --panel <panel-id> --for idle --json\`
- Send a message: \`runpane panels submit --panel <panel-id> --text "<message>" --yes --json\`

## Sessions

When \`PANE_ORCHESTRATION_SESSION_ID\` is set you are a Session orchestrator.
When \`panes create\` or \`panes adopt\` returns an \`association\` result,
check \`association.ok\`. Confirm with
\`runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json\`.
If the Pane is absent, including when an older CLI returns no association
result, run \`runpane sessions associate --session "$PANE_ORCHESTRATION_SESSION_ID" --pane <pane-id> --json\`
and confirm again before sending work.
Never take over a Pane that belongs to another Session.

Opening a terminal or Session is not a request to start work. Act on the
user's request, and do not focus Pane windows unless the user asks.
`;
}
