import { readFile, readdir, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { CommandRunner } from '../utils/commandRunner';
import { escapeForBash, linuxToUNCPath } from '../utils/wslUtils';
import { ShellDetector } from '../utils/shellDetector';
import { agentPresetsForPlatform } from '../../../shared/constants/agentLaunchPresets';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { resolveProjectRegistration, validateProjectRepository } from './projectRegistration';
import type { FoundRepo, HostRepos, RepoSource, WslRepos } from '../../../shared/types/onboarding';

/**
 * Finds the repos a new user most likely wants to open, for the first-run
 * "Open your project" screen. Read-only: it reads Claude Code's and Codex's
 * project lists, then common code folders one level deep, and asks git for
 * each candidate's main repo, branch and last commit. It never walks the disk.
 */

interface Candidate {
  path: string;
  source: RepoSource;
}

interface GitRecord {
  candidate: Candidate;
  /** The repo's shared git dir, as git printed it (may be relative to the candidate). */
  commonDir: string;
  /** `git log -1 --format=%ct%n%D` output. */
  log: string;
}

const MAX_REPOS = 5;
const HOST_BUDGET_MS = 3_000;
const WSL_BUDGET_MS = 8_000;
const GIT_CONCURRENCY = 8;
const HOME_CODE_FOLDERS = [
  'code', 'Code', 'dev', 'Developer', 'projects', 'Projects', 'src', 'repos', 'GitHub', 'github',
  'Documents/GitHub', 'source/repos', 'work', 'workspace',
];
const WINDOWS_DRIVE_CODE_FOLDERS = ['code', 'dev', 'src', 'projects', 'repos'];
const LOG_FORMAT = '--format=%ct%n%D';
const MARK = '@@PANE-FINDER@@';

/** Absolute-path keys of `projects` in Claude Code's ~/.claude.json. */
function claudeProjectPaths(text: string | null): string[] {
  if (!text) return [];
  try {
    const config = decodeBoundary(JSON.parse(text), boundary.object({ projects: boundary.optional(boundary.jsonObject) }));
    return Object.keys(config.projects ?? {});
  } catch {
    return [];
  }
}

/** Paths from `[projects."<path>"]` tables in Codex's config.toml. */
export function codexProjectPaths(text: string | null): string[] {
  if (!text) return [];
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const basic = /^\s*\[projects\."((?:[^"\\]|\\.)*)"\]\s*$/.exec(line);
    if (basic) {
      paths.push(basic[1].replace(/\\(["\\])/g, '$1'));
      continue;
    }
    const literal = /^\s*\[projects\.'([^']*)'\]\s*$/.exec(line);
    if (literal) paths.push(literal[1]);
  }
  return paths;
}

function parseLog(log: string) {
  const [time = '', refs = ''] = log.trim().split('\n');
  const seconds = Number.parseInt(time, 10);
  return {
    lastCommitAt: Number.isFinite(seconds) ? seconds * 1000 : null,
    branch: /HEAD -> ([^,\s]+)/.exec(refs)?.[1] ?? null,
  };
}

interface RankOptions {
  pathApi: path.PlatformPath;
  home: string;
  caseInsensitive: boolean;
  excluded: string[];
  toOpenPath: (root: string) => string;
}

/** Turns git answers into at most five repos, newest commit first. */
function rankRepos(records: GitRecord[], options: RankOptions): FoundRepo[] {
  const { pathApi, home, caseInsensitive } = options;
  const key = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  const excluded = new Set([home, ...options.excluded].map(value => key(pathApi.resolve(value))));
  const homePrefix = key(home.endsWith(pathApi.sep) ? home : home + pathApi.sep);
  const seen = new Set<string>();
  const repos: FoundRepo[] = [];

  for (const record of records) {
    const commonDir = pathApi.resolve(record.candidate.path, record.commonDir.trim());
    // A main repo's shared dir is <root>/.git; bare repos and submodules are skipped.
    if (pathApi.basename(commonDir) !== '.git') continue;
    const root = pathApi.dirname(commonDir);
    const rootKey = key(root);
    if (seen.has(rootKey) || excluded.has(rootKey)) continue;
    seen.add(rootKey);
    const displayPath = key(root).startsWith(homePrefix) ? `~${pathApi === path.win32 ? '\\' : '/'}${root.slice(homePrefix.length)}` : root;
    repos.push({
      name: pathApi.basename(root),
      path: options.toOpenPath(root),
      displayPath,
      source: record.candidate.source,
      ...parseLog(record.log),
    });
  }

  return repos
    .sort((a, b) => (b.lastCommitAt ?? -1) - (a.lastCommitAt ?? -1))
    .slice(0, MAX_REPOS);
}

function orderedCandidates(claude: string[], codex: string[], folders: string[]): Candidate[] {
  return [
    ...claude.map(candidatePath => ({ path: candidatePath, source: 'claude_config' as const })),
    ...codex.map(candidatePath => ({ path: candidatePath, source: 'codex_config' as const })),
    ...folders.map(candidatePath => ({ path: candidatePath, source: 'code_folder' as const })),
  ];
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function gitChildren(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const children = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => path.join(dir, entry.name));
  const flags = await Promise.all(children.map(async child => {
    try {
      await stat(path.join(child, '.git'));
      return true;
    } catch {
      return false;
    }
  }));
  return children.filter((_, index) => flags[index]);
}

/** Runs tasks GIT_CONCURRENCY at a time and returns what finished by the deadline. */
async function runWithinBudget<Result>(tasks: Array<() => Promise<Result | null>>, deadline: number): Promise<Result[]> {
  const results: Array<Result | null> = new Array(tasks.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && Date.now() < deadline) {
      const index = next++;
      results[index] = await tasks[index]().catch(() => null);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
  await Promise.race([Promise.all(Array.from({ length: GIT_CONCURRENCY }, worker)), timeout]);
  clearTimeout(timer);
  // Keep the candidates' order so the first source to name a repo is the one reported.
  return results.filter((result): result is Result => result !== null);
}

function shortShellNames(): string[] {
  const names = ShellDetector.getAvailableShells()
    .filter(shell => shell.id !== 'cmd')
    .map(shell => shell.name.includes('PowerShell') ? 'PowerShell' : shell.name);
  return [...new Set(names)];
}

export interface HostFinderOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Repo roots never to list, such as Pane's own sample repo. */
  excluded?: string[];
  budgetMs?: number;
}

/** Repos on this computer, up to five, newest commit first. */
export async function findHostRepos(options: HostFinderOptions = {}): Promise<FoundRepo[]> {
  const deadline = Date.now() + (options.budgetMs ?? HOST_BUDGET_MS);
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  const folderRoots = HOME_CODE_FOLDERS.map(folder => path.join(home, folder));
  if (platform === 'win32') {
    const drive = env.SystemDrive || 'C:';
    folderRoots.push(...WINDOWS_DRIVE_CODE_FOLDERS.map(folder => `${drive}\\${folder}`));
  }
  const [claudeText, codexText, folderChildren] = await Promise.all([
    readText(path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')),
    readText(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')),
    Promise.all(folderRoots.map(gitChildren)),
  ]);

  const candidates = orderedCandidates(claudeProjectPaths(claudeText), codexProjectPaths(codexText), folderChildren.flat());
  const records = await runWithinBudget(candidates.map(candidate => async (): Promise<GitRecord | null> => {
    if (!await isDirectory(candidate.path)) return null;
    const runner = new CommandRunner({ path: candidate.path, wsl_enabled: false });
    const timeout = Math.max(1, deadline - Date.now());
    const commonDir = (await runner.execFile('git', ['rev-parse', '--git-common-dir'], candidate.path, { silent: true, timeout })).stdout;
    const resolved = pathApi.resolve(candidate.path, commonDir.trim());
    const log = await runner.execFile('git', ['--git-dir', resolved, 'log', '-1', LOG_FORMAT], candidate.path, { silent: true, timeout })
      .then(result => result.stdout, () => '');
    return { candidate, commonDir, log };
  }), deadline);

  return rankRepos(records, {
    pathApi,
    home,
    caseInsensitive: platform === 'win32' || platform === 'darwin',
    excluded: options.excluded ?? [],
    toOpenPath: root => root,
  });
}

/** What the first screen needs about this computer: its repos, its shells, and its default WSL distro. */
export async function findHostRepoContext(options: HostFinderOptions & { getDefaultWslDistro: () => Promise<string | undefined> }): Promise<HostRepos> {
  const isWindows = (options.platform ?? process.platform) === 'win32';
  const [repos, wslDistro] = await Promise.all([
    findHostRepos(options),
    isWindows ? options.getDefaultWslDistro() : Promise.resolve(undefined),
  ]);
  return { repos, shells: isWindows ? shortShellNames() : [], wslDistro: wslDistro ?? null };
}

function section(output: string, name: string): string {
  const start = output.indexOf(`${MARK}${name}\n`);
  if (start < 0) return '';
  const body = output.slice(start + MARK.length + name.length + 1);
  const end = body.indexOf(MARK);
  return end < 0 ? body : body.slice(0, end);
}

function lines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * Repos inside a WSL distribution, read in two calls into the distro (one for
 * the config files, folders and agents, one for git), never one per repo.
 */
export async function findWslRepos(distro: string, options: { excluded?: string[]; budgetMs?: number } = {}): Promise<WslRepos> {
  const deadline = Date.now() + (options.budgetMs ?? WSL_BUDGET_MS);
  const runner = new CommandRunner({ path: '/', wsl_enabled: true, wsl_distribution: distro });
  const run = async (script: string) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('time budget spent');
    // A login shell, so agents on a PATH set in shell profiles are found.
    return (await runner.execFile('bash', ['-lc', script], '/', { silent: true, timeout })).stdout;
  };
  const presets = agentPresetsForPlatform('wsl').map(preset => ({ title: preset.title, binary: preset.command.split(' ')[0] }));
  const folders = HOME_CODE_FOLDERS.map(folder => `"$HOME"/${escapeForBash(folder)}/*/`).join(' ');

  const first = await run([
    `printf '${MARK}home\\n%s\\n' "$HOME"`,
    `printf '${MARK}claude\\n'; cat "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" 2>/dev/null; echo`,
    `printf '${MARK}codex\\n'; cat "\${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null; echo`,
    `printf '${MARK}folders\\n'; for c in ${folders}; do [ -e "$c.git" ] && printf '%s\\n' "\${c%/}"; done`,
    `printf '${MARK}agents\\n'; for a in ${presets.map(preset => escapeForBash(preset.binary)).join(' ')}; do command -v "$a" >/dev/null 2>&1 && printf '%s\\n' "$a"; done`,
    `printf '${MARK}end\\n'`,
  ].join('\n'));

  const home = lines(section(first, 'home'))[0] ?? '/';
  const foundBinaries = new Set(lines(section(first, 'agents')));
  const agents = presets.filter(preset => foundBinaries.has(preset.binary)).map(preset => preset.title);
  const candidates = orderedCandidates(
    claudeProjectPaths(section(first, 'claude')).filter(candidate => candidate.startsWith('/')),
    codexProjectPaths(section(first, 'codex')).filter(candidate => candidate.startsWith('/')),
    lines(section(first, 'folders')),
  );

  let records: GitRecord[] = [];
  if (candidates.length > 0) {
    // One record per candidate: the marker, the candidate, its common dir, then git log's two lines.
    const second = await run(`for c in ${candidates.map(candidate => escapeForBash(candidate.path)).join(' ')}; do
  [ -d "$c" ] || continue
  g=$(git -C "$c" rev-parse --git-common-dir 2>/dev/null) || continue
  case "$g" in /*) ;; *) g="$c/$g" ;; esac
  printf '${MARK}\\n%s\\n%s\\n' "$c" "$g"
  git --git-dir="$g" log -1 ${LOG_FORMAT} 2>/dev/null
done`);
    const byPath = new Map(candidates.map(candidate => [candidate.path, candidate]));
    records = second.split(`${MARK}\n`).slice(1).flatMap((block): GitRecord[] => {
      const [candidatePath = '', commonDir = '', ...log] = block.split('\n');
      const candidate = byPath.get(candidatePath);
      return candidate ? [{ candidate, commonDir, log: log.join('\n') }] : [];
    });
  }

  return {
    distro,
    agents,
    repos: rankRepos(records, {
      pathApi: path.posix,
      home,
      caseInsensitive: false,
      excluded: options.excluded ?? [],
      toOpenPath: root => linuxToUNCPath(root, distro),
    }),
  };
}

/** Checks a folder the user picked; throws a PaneError when it is not a Git repo. */
export async function checkRepoFolder(folder: string, home = os.homedir()): Promise<{ name: string; path: string }> {
  const registration = resolveProjectRegistration(folder);
  try {
    await validateProjectRepository(registration);
    // A dotfiles repo at home would make every folder under it pass.
    if (!registration.wsl_enabled) {
      const topLevel = (await registration.commandRunner.execFile('git', ['rev-parse', '--show-toplevel'], registration.path, { silent: true })).stdout.trim();
      const key = (value: string) => process.platform === 'linux' ? path.resolve(value) : path.resolve(value).toLowerCase();
      if (key(topLevel) === key(home)) throw new Error('home repo');
    }
  } catch {
    throw new PaneError(
      'ONBOARDING_NOT_A_REPO',
      "That folder isn't a Git repo.",
      'Choose a repo folder. To start a new repo, skip this and use Add repository.',
    );
  }
  return { name: path.posix.basename(registration.path.replace(/\\/g, '/')) || registration.path, path: folder };
}
