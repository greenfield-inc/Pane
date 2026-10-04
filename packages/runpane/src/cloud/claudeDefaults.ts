import childProcess from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundary, decodeBoundary } from '../boundaryDecoder';

/** A model id or alias as `claude --model` takes it: claude-opus-5-5, opus, claude-opus-5-5[1m]. */
const MODEL_PATTERN = /^[A-Za-z0-9][\]A-Za-z0-9._:@/[-]{0,99}$/u;

const settingsSchema = boundary.object({ model: boundary.optional(boundary.string) });

/**
 * The model the user's own Claude Code starts with when Pane launches it on this machine. Pane's Claude panels pass
 * no `--model` (agentTemplates `claude --dangerously-skip-permissions`), so Claude Code resolves it: `ANTHROPIC_MODEL`,
 * then `model` in the user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). Null when
 * neither is set (Claude Code then picks its own default for the account) or the value is not a model id.
 */
export async function readLocalClaudeModel(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Promise<string | null> {
  const fromEnv = env.ANTHROPIC_MODEL?.trim();
  if (fromEnv) return MODEL_PATTERN.test(fromEnv) ? fromEnv : null;
  let text: string;
  try {
    text = await fs.readFile(settingsPath(env, home), 'utf8');
  } catch {
    return null;
  }
  try {
    const model = decodeBoundary(JSON.parse(text), settingsSchema).model?.trim();
    return model && MODEL_PATTERN.test(model) ? model : null;
  } catch {
    return null;
  }
}

interface DefaultClaudeModelSourceOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** The `claude` executable to ask; default: the first one on `env.PATH` (with `PATHEXT` on Windows). */
  claudePath?: () => Promise<string | null>;
  /** How long the probe waits for Claude's init line (default 15 s). */
  timeoutMs?: number;
  /** A failed detection, in words without secrets (default: stderr). */
  onNotice?: (message: string) => void;
}

/** One detection, for one claude executable and settings file state. */
class CachedDetection {
  model: Promise<string | null> = Promise.resolve(null);
  failedAt?: number;
  constructor(readonly key: string) {}
}

/** How long a failed detection is remembered before the next try. */
const FAILED_PROBE_RETRY_MS = 5 * 60_000;
/** Every proxy variable points here, so the probe's request can't leave this machine (connection refused). */
const DEAD_PROXY = 'http://127.0.0.1:9';
const PROBE_PROMPT = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })}\n`;
const PROBE_ARGS = ['-p', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/**
 * The user's default Claude model on this machine, "explicit wins, else detect": `ANTHROPIC_MODEL` or settings
 * `model` (readLocalClaudeModel); with neither, the model the user's own Claude Code resolves for itself (its account
 * default), read from Claude Code's `system/init` line by an offline probe (probeClaudeModel). Detection is cached per
 * claude executable (path, size, mtime) and settings mtime; a failure returns null (cloud sandboxes then keep Claude
 * Code's own default) and reports a notice, and is retried after five minutes.
 */
export function createDefaultClaudeModelSource(options: DefaultClaudeModelSourceOptions = {}): () => Promise<string | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const findClaude = options.claudePath ?? (() => findExecutable('claude', env, platform));
  const notice = options.onNotice ?? ((message: string) => process.stderr.write(`${message}\n`));
  let cached: CachedDetection | undefined;

  return async () => {
    const explicit = await readLocalClaudeModel(env, home);
    if (explicit) return explicit;
    const claude = await findClaude();
    if (!claude) {
      notice('Could not detect your Claude Code default model: claude was not found on PATH. Cloud sandboxes keep Claude Code\'s own default.');
      return null;
    }
    const key = `${await fileIdentity(claude)}|${await fileIdentity(settingsPath(env, home))}`;
    const stale = cached?.failedAt !== undefined && Date.now() - cached.failedAt > FAILED_PROBE_RETRY_MS;
    if (!cached || cached.key !== key || stale) {
      const entry = new CachedDetection(key);
      entry.model = probeClaudeModel(claude, { env, home, platform, timeoutMs: options.timeoutMs }).then((result) => {
        if ('model' in result) return result.model;
        entry.failedAt = Date.now();
        notice(`Could not detect your Claude Code default model (${result.failure}). Cloud sandboxes keep Claude Code's own default.`);
        return null;
      });
      cached = entry;
    }
    return cached.model;
  };
}

type ProbeResult = { model: string } | { failure: string };

/**
 * Asks the user's Claude Code which model it starts with, without a turn: it runs `claude -p` with every proxy
 * variable pointing at a closed local port, sends one placeholder message, reads the `{"type":"system","subtype":
 * "init","model":…}` line Claude prints before it calls the API, and kills it (the call can't leave this machine).
 * Pane reads only that output; Claude reads its own sign-in as any panel launch does. Nothing is saved
 * (`--no-session-persistence`), and the empty project folder Claude makes for the probe's temp dir is removed.
 */
async function probeClaudeModel(
  claudePath: string,
  options: { env: NodeJS.ProcessEnv; home: string; platform: NodeJS.Platform; timeoutMs?: number },
): Promise<ProbeResult> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-claude-probe-'));
  const projectsDir = path.join(claudeConfigDir(options.env, options.home), 'projects');
  const env: NodeJS.ProcessEnv = { ...options.env };
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) env[name] = DEAD_PROXY;
  delete env.NO_PROXY;
  delete env.no_proxy;
  const { command, args, windowsVerbatimArguments } = probeCommand(claudePath, options.platform, options.env);
  try {
    return await new Promise<ProbeResult>((resolve) => {
      let settled = false;
      let buffer = '';
      const child = childProcess.spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments,
        // Its own process group on POSIX, so the whole tree goes on kill.
        detached: options.platform !== 'win32',
      });
      const finish = (result: ProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child, options.platform);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ failure: `no answer from claude within ${Math.round((options.timeoutMs ?? 15_000) / 1000)} s` }),
        options.timeoutMs ?? 15_000);
      child.on('error', (error) => finish({ failure: `claude could not start: ${error.message}` }));
      // 'close', not 'exit': stdout is drained by then, so an init line printed just before exiting still counts.
      child.on('close', (code) => finish({ failure: `claude exited (${String(code)}) before reporting its model` }));
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const model = initModel(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (model !== undefined) {
            finish(model && MODEL_PATTERN.test(model) ? { model } : { failure: 'claude reported no usable model' });
            return;
          }
          newline = buffer.indexOf('\n');
        }
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(PROBE_PROMPT);
    });
  } finally {
    await removeProbeProjectFolders(projectsDir, path.basename(cwd));
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

const initLineSchema = boundary.object({
  type: boundary.string,
  subtype: boundary.optional(boundary.string),
  model: boundary.optional(boundary.string),
});

/** The model on a `system/init` line; '' when that line has none; undefined for any other line. */
function initModel(line: string): string | undefined {
  try {
    const parsed = decodeBoundary(JSON.parse(line), initLineSchema);
    if (parsed.type !== 'system' || parsed.subtype !== 'init') return undefined;
    return parsed.model?.trim() ?? '';
  } catch {
    return undefined;
  }
}

/**
 * How to start `claude` without a shell. Windows can't spawn a .cmd/.bat (an npm install's shim) directly, so it goes
 * through cmd.exe with fixed arguments; nothing user-supplied is on that command line.
 */
export function probeCommand(claudePath: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/iu.test(claudePath)) {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${[`"${claudePath}"`, ...PROBE_ARGS].join(' ')}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: claudePath, args: PROBE_ARGS, windowsVerbatimArguments: false };
}

function killTree(child: childProcess.ChildProcess, platform: NodeJS.Platform): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (platform === 'win32') {
      childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

/** Claude names a project folder after its directory; remove the probe's, and only when no file is in it. */
async function removeProbeProjectFolders(projectsDir: string, probeDirName: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    return;
  }
  for (const entry of entries.filter((name) => name.endsWith(probeDirName))) {
    const folder = path.join(projectsDir, entry);
    if (!(await containsFile(folder))) await fs.rm(folder, { recursive: true, force: true });
  }
}

async function containsFile(dir: string): Promise<boolean> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (await containsFile(path.join(dir, entry.name))) return true;
  }
  return false;
}

/** The first `name` on PATH, trying each PATHEXT extension on Windows. */
async function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const separator = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension.toLowerCase()}`);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile() && (platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Changes when the file is replaced or edited: an upgraded claude, or edited settings. */
async function fileIdentity(file: string): Promise<string> {
  try {
    const real = await fs.realpath(file);
    const stat = await fs.stat(real);
    return `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${file}:missing`;
  }
}

/** Claude Code's user config folder, which holds settings.json: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
}

function settingsPath(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(claudeConfigDir(env, home), 'settings.json');
}
