import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NotifyInstructionsFile } from '../../../../shared/types/notify';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import { linuxToUNCPath, windowsPathToWSLMount } from '../../utils/wslUtils';
import { agentsIntroForInstructions, scratchRule } from '../../../../packages/runpane/src/paneIntro';
import { LeftAlone, writeOwnedBlock, type BlockMarkers } from '../instructionsBlock';

/**
 * A few lines in the agents' user-level instruction files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md)
 * that tell them Pane is there and to ask through `notify`, edited with writeOwnedBlock.
 */
const NOTIFY_BLOCK_BEGIN = '<!-- pane-notify:begin (managed by Pane; edits are replaced) -->';
const NOTIFY_BLOCK_END = '<!-- pane-notify:end -->';
const NOTIFY_MARKERS: BlockMarkers = {
  // Matches the begin marker whatever its note says, so a reworded marker is still found.
  begin: '<!-- pane-notify:begin',
  end: NOTIFY_BLOCK_END,
  repair: 'turn Notify off and on',
};
const execFileAsync = promisify(execFile);

export interface NotifyInstructionsOptions {
  /** Pane's `pane` home skill is installed, so the block can tell agents to load it. */
  homeSkill: boolean;
}

/** Which shells read the file, which decides how the block spells Pane's runpane. */
type InstructionsHome = 'posix' | 'windows' | 'wsl';

/**
 * Where the installed Pane keeps its runpane shim, in this home's terms. It names the default data
 * folder, not a dev or test PANE_DIR, so a development build never points the agents at its copy.
 */
function runpaneFallback(kind: InstructionsHome, home: string): string {
  const shim = (name: string) => (kind === 'posix' ? path.posix : path.win32).join(home, '.pane', 'bin', name);
  const location = kind === 'posix' ? shim('runpane')
    : kind === 'wsl' ? windowsPathToWSLMount(shim('runpane'))
    // Forward slashes work in PowerShell, cmd and Git Bash alike.
    : shim('runpane.cmd').replace(/\\/g, '/');
  const powershell = kind === 'windows' ? '; PowerShell: `& $env:PANE_RUNPANE_BIN`' : '';
  return `If \`runpane\` isn't on PATH, run \`$PANE_RUNPANE_BIN\` (Pane terminals set it${powershell}), or else \`${location}\`.`;
}

function renderBlock(options: NotifyInstructionsOptions, fallback: string): string[] {
  const { rules } = RUNPANE_CONTRACT.agentContext.notifyGuidance;
  return [
    NOTIFY_BLOCK_BEGIN,
    '## Pane',
    agentsIntroForInstructions(),
    `- ${scratchRule()}`,
    options.homeSkill
      ? 'When PANE_SESSION_ID is set, you are in a Pane terminal: load the `pane` skill before using Pane (worktrees, Panes, Sessions, asking the person).'
      : 'When PANE_SESSION_ID is set, you are in a Pane terminal: `runpane agent-context --json` lists what you can do with Pane (worktrees, Panes, Sessions, asking the person).',
    fallback,
    '',
    '## Pane Notify',
    "When you need the person (a choice, an approval, a short answer), call the `pane` MCP's `notify` instead of asking in the terminal; its description says how to write the card. If that tool isn't loaded, run `runpane notify --ui options|approve|ask|info --title <text>` (`runpane notify --help` has the rest).",
    ...rules.map(rule => `- ${rule}`),
    NOTIFY_BLOCK_END,
  ];
}

interface InstructionsTarget {
  agent: NotifyInstructionsFile['agent'];
  dir: string;
  name: string;
}

/**
 * Writes the block while Notify is on and removes it when Notify is off. A file is created only
 * when its agent's config folder exists, and never deleted. A symlink, anything but a regular file,
 * a file that isn't UTF-8 and a file whose markers don't pair up are left alone.
 */
export function syncNotifyInstructions(
  enabled: boolean,
  options: NotifyInstructionsOptions,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): NotifyInstructionsFile[] {
  const block = renderBlock(options, runpaneFallback(platform === 'win32' ? 'windows' : 'posix', home));
  return [
    syncTarget({ agent: 'Claude Code', dir: env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'), name: 'CLAUDE.md' }, enabled, block),
    syncTarget({ agent: 'Codex', dir: env.CODEX_HOME?.trim() || path.join(home, '.codex'), name: 'AGENTS.md' }, enabled, block),
  ];
}

/** Claude's and Codex's config folders in a distro, as paths Windows can open. */
export interface WslAgentDirs {
  claude: string;
  codex: string;
}

/**
 * The same block in each WSL distro's own home, which agents running there read instead of the
 * Windows one. Pane reaches the files as \\wsl.localhost paths. A distro that doesn't answer is one
 * skipped entry, tried again at the next sync.
 */
export async function syncWslNotifyInstructions(
  enabled: boolean,
  options: NotifyInstructionsOptions,
  distros: string[],
  windowsHome = os.homedir(),
  resolveDirs: (distro: string) => Promise<WslAgentDirs> = resolveWslAgentDirs,
): Promise<NotifyInstructionsFile[]> {
  const block = renderBlock(options, runpaneFallback('wsl', windowsHome));
  const results: NotifyInstructionsFile[] = [];
  for (const distro of distros) {
    let dirs: WslAgentDirs;
    try {
      dirs = await resolveDirs(distro);
    } catch (error) {
      const reason = `Pane could not find the agents' folders in WSL distro ${distro} (${error instanceof Error ? error.message : String(error)}), so it changed nothing there. Pane tries again at its next launch.`;
      console.warn(`[Notify] ${reason}`);
      results.push({ agent: 'Claude Code', file: linuxToUNCPath('/', distro), state: 'skipped', reason });
      continue;
    }
    results.push(
      syncTarget({ agent: 'Claude Code', dir: dirs.claude, name: 'CLAUDE.md' }, enabled, block),
      syncTarget({ agent: 'Codex', dir: dirs.codex, name: 'AGENTS.md' }, enabled, block),
    );
  }
  return results;
}

/** Claude's and Codex's config folders as the distro's login shell sets them. */
async function resolveWslAgentDirs(distro: string): Promise<WslAgentDirs> {
  const { stdout } = await execFileAsync('wsl.exe', [
    '-d', distro, '--', 'bash', '-lc',
    'printf "%s\\n%s\\n" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}"',
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const [claude, codex] = stdout.trim().split(/\r?\n/).map(value => value.trim());
  if (!claude?.startsWith('/') || !codex?.startsWith('/')) throw new Error(`it printed ${JSON.stringify(stdout.trim())}, not two absolute paths`);
  return { claude: linuxToUNCPath(claude, distro), codex: linuxToUNCPath(codex, distro) };
}

function syncTarget({ agent, dir, name }: InstructionsTarget, enabled: boolean, block: string[]): NotifyInstructionsFile {
  const file = path.join(dir, name);
  try {
    return { agent, file, state: syncFile(dir, file, enabled ? block : undefined) };
  } catch (error) {
    const reason = error instanceof LeftAlone ? error.message
      : `Pane could not update it (${error instanceof Error ? error.message : String(error)}).`;
    console.warn(`[Notify] ${file}: ${reason}`);
    return { agent, file, state: 'skipped', reason };
  }
}

/** `block` is what to write; undefined removes Pane's lines. */
function syncFile(dir: string, file: string, block: string[] | undefined): NotifyInstructionsFile['state'] {
  if (!fs.existsSync(dir)) return 'not-found';
  writeOwnedBlock(file, NOTIFY_MARKERS, block);
  return block ? 'written' : 'absent';
}
