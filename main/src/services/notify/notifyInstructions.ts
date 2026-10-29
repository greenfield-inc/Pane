import { execFile } from 'child_process';
import fs, { constants } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NotifyInstructionsFile } from '../../../../shared/types/notify';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import { linuxToUNCPath, windowsPathToWSLMount } from '../../utils/wslUtils';

/**
 * A few lines in the agents' user-level instruction files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md)
 * that tell them Pane is there and to ask through `notify`. Pane owns exactly the bytes it wrote:
 * the marked lines and, when it had to start a new line at the end of the file for them, that one
 * line break. Everything else, line endings and any byte order mark included, stays as it was.
 */
const NOTIFY_BLOCK_BEGIN = '<!-- pane-notify:begin (managed by Pane; edits are replaced) -->';
const NOTIFY_BLOCK_END = '<!-- pane-notify:end -->';
/** Matches the begin marker whatever its note says, so a reworded marker is still found. */
const BEGIN_PREFIX = '<!-- pane-notify:begin';
const BOM = '\uFEFF';
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
  const { rules, cardRule, results } = RUNPANE_CONTRACT.agentContext.notifyGuidance;
  return [
    NOTIFY_BLOCK_BEGIN,
    '## Pane',
    options.homeSkill
      ? 'When PANE_SESSION_ID is set, you are in a Pane terminal: load the `pane` skill before using Pane (worktrees, Panes, Sessions, asking the person).'
      : 'When PANE_SESSION_ID is set, you are in a Pane terminal: `runpane agent-context --json` lists what you can do with Pane (worktrees, Panes, Sessions, asking the person).',
    fallback,
    '',
    '## Pane Notify',
    "When you need the person (a choice, an approval, a short answer), call the `pane` MCP's `notify` instead of asking in the terminal. If that tool isn't loaded, run `runpane notify --ui options|approve|ask|info --title <text>` (`runpane notify --help` has the rest).",
    ...rules.map(rule => `- ${rule}`),
    `- ${results}`,
    cardRule,
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

/** A file Pane must not edit; the message says why. */
class LeftAlone extends Error {}

/** Another program saves while Pane writes rarely more than once; past this, Pane tries at the next launch. */
const WRITE_ATTEMPTS = 3;

/** `block` is what to write; undefined removes Pane's lines. */
function syncFile(dir: string, file: string, block: string[] | undefined): NotifyInstructionsFile['state'] {
  if (!fs.existsSync(dir)) return 'not-found';
  const state = block ? 'written' : 'absent';
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = readFile(file);
    const next = editText(current?.text ?? '', block);
    if (next === (current?.text ?? '')) return state;
    if (commit(file, current, next)) return state;
  }
  throw new LeftAlone('It kept changing while Pane wrote to it, so Pane left it as it was. Pane tries again at its next launch.');
}

interface ReadFile {
  text: string;
  /** Which file the text came from, so Pane notices one saved in its place. */
  ino: bigint;
  mode: number;
}

/** The file's text; undefined when it is missing. */
function readFile(file: string): ReadFile | undefined {
  let entry: fs.BigIntStats;
  try {
    // lstat first, on every platform: Windows has no O_NOFOLLOW, and opening a FIFO would wait forever.
    entry = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    // SAFETY: fs.lstatSync throws only Node system errors, which carry `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new LeftAlone('It is a symlink, so Pane leaves it alone.');
  if (!entry.isFile()) throw new LeftAlone('It is not a regular file, so Pane leaves it alone.');
  let fd: number;
  try {
    // Where the platform has them, these keep a path swapped since lstat from making Pane follow a link or wait.
    fd = fs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // SAFETY: fs.openSync throws only Node system errors, which carry `code`.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new LeftAlone('It is a symlink, so Pane leaves it alone.');
    throw error;
  }
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== entry.ino) return readFile(file);
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new LeftAlone("It isn't UTF-8 text, so Pane leaves it alone.");
  return { text, ino: entry.ino, mode: Number(entry.mode & 0o777n) };
}

/**
 * Puts `next` in place of the file Pane read. Returns false when another program changed or
 * replaced it meanwhile; their version is then back in place for Pane to start over from.
 */
function commit(file: string, read: ReadFile | undefined, next: string): boolean {
  const stamp = `${process.pid}.${Date.now()}`;
  const tmp = `${file}.${stamp}.tmp`;
  fs.writeFileSync(tmp, next, { mode: read?.mode ?? 0o644, flag: 'wx' });
  try {
    if (!read) {
      // link() refuses to replace a file someone created since Pane looked.
      try {
        fs.linkSync(tmp, file);
        return true;
      } catch (error) {
        // SAFETY: fs.linkSync throws only Node system errors, which carry `code`.
        const { code } = error as NodeJS.ErrnoException;
        if (code === 'EEXIST') return false;
        if (code !== 'ENOTSUP') throw error;
      }
      // No hard links here (a WSL home over \\wsl.localhost): an exclusive create refuses just the same.
      try {
        fs.writeFileSync(file, next, { mode: 0o644, flag: 'wx' });
        return true;
      } catch (error) {
        // SAFETY: fs.writeFileSync throws only Node system errors, which carry `code`.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    }
    // A second name for the file Pane read: a save that lands on it during the swap survives there.
    const kept = `${file}.${stamp}.kept`;
    try {
      fs.linkSync(file, kept);
    } catch (error) {
      // SAFETY: fs.linkSync throws only Node system errors, which carry `code`.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTSUP') throw error;
      // Without hard links, Pane checks the file is still the one it read right before the swap.
      if (fs.lstatSync(file, { bigint: true }).ino !== read.ino || fs.readFileSync(file, 'utf8') !== read.text) return false;
      fs.renameSync(tmp, file);
      return true;
    }
    try {
      if (fs.lstatSync(file, { bigint: true }).ino !== read.ino) return false;
      fs.renameSync(tmp, file);
      if (fs.readFileSync(kept, 'utf8') === read.text) return true;
      fs.renameSync(kept, file);
      return false;
    } finally {
      fs.rmSync(kept, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const bare = (line: string) => line.replace(/\r$/, '');

/** Where Pane's bytes sit in the text; undefined when there is no block. */
function findOwned(body: string): { start: number; end: number } | undefined {
  const lines: { start: number; text: string }[] = [];
  for (let start = 0; start <= body.length;) {
    const lineEnd = body.indexOf('\n', start);
    const end = lineEnd === -1 ? body.length : lineEnd;
    lines.push({ start, text: body.slice(start, end) });
    start = end + 1;
  }
  const begins = lines.filter(line => bare(line.text).trim().startsWith(BEGIN_PREFIX));
  const ends = lines.filter(line => bare(line.text).trim() === NOTIFY_BLOCK_END);
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || ends[0].start < begins[0].start) {
    throw new LeftAlone("Pane's pane-notify markers in it don't pair up, so Pane leaves it alone. Remove the stray marker and turn Notify off and on.");
  }
  const start = begins[0].start;
  const endOfEndLine = ends[0].start + ends[0].text.length;
  if (endOfEndLine < body.length) return { start, end: endOfEndLine + 1 };
  // A block that ends the file without a line break: Pane started its line, so that break is Pane's too.
  const eol = begins[0].text.endsWith('\r') ? '\r\n' : '\n';
  return { start: body.slice(start - eol.length, start) === eol ? start - eol.length : start, end: body.length };
}

/**
 * Adds or refreshes Pane's bytes as `block`, or removes them when there is none: appended at the
 * end when new, replaced where they stand otherwise.
 */
function editText(current: string, block: string[] | undefined): string {
  // A byte order mark stays where it is, outside the edit; none is ever added.
  const bom = current.startsWith(BOM) ? BOM : '';
  const body = current.slice(bom.length);
  const owned = findOwned(body);
  const own = owned ? body.slice(0, owned.start) + body.slice(owned.end) : body;
  if (!block) return bom + own;
  const at = owned?.start ?? own.length;
  const eol = own.includes('\r\n') ? '\r\n' : '\n';
  const text = block.join(eol);
  // At the end of text without a final line break, Pane starts the block's line and leaves the end as it found it.
  const startsLine = at === own.length && own !== '' && !own.endsWith('\n');
  return bom + own.slice(0, at) + (startsLine ? eol + text : text + eol) + own.slice(at);
}
