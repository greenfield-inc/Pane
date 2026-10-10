import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { glob } from 'glob';

/**
 * Lists the concrete Host aliases in the user's SSH config, the hosts a user
 * can reach with a plain `ssh <alias>`.
 *
 * Reads only `<home>/.ssh/config` and the files it Includes, in the order
 * OpenSSH would: Include globs expand in lexical order, relative paths resolve
 * against `<home>/.ssh`, and an Include cycle stops. Only Includes that apply
 * to every host are followed (top level or under `Host *`). Patterns (`*`, `?`, `!`)
 * and aliases outside a shell-safe form are skipped, because each alias is
 * later typed into a shell. A missing or unreadable file lists
 * nothing. Key files are never opened.
 */
export async function listSshConfigHosts(home = sshUserHome()): Promise<string[]> {
  const sshDir = path.join(home, '.ssh');
  const hosts = new Set<string>();
  await readConfigFile(path.join(sshDir, 'config'), { home, sshDir, hosts, visited: new Set() });
  return [...hosts];
}

/**
 * The home directory ssh reads its config from. ssh ignores `$HOME`: it uses
 * the OS user record on macOS and Linux and the profile folder on Windows,
 * which is what `os.userInfo()` reports.
 */
function sshUserHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/**
 * Every shell Pane starts (bash, zsh, fish, PowerShell, cmd) reads such an alias
 * as one literal word, and ssh reads it as a destination: it starts with a
 * letter, digit or underscore, so it is never an option (`-V`) or a PowerShell
 * splat (`@prod`).
 */
const SAFE_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/;

interface ReadContext {
  home: string;
  sshDir: string;
  hosts: Set<string>;
  visited: Set<string>;
}

async function readConfigFile(file: string, context: ReadContext): Promise<void> {
  const key = path.resolve(file);
  if (context.visited.has(key)) return;
  context.visited.add(key);

  let text: string;
  try {
    text = await fs.readFile(key, 'utf8');
  } catch {
    return;
  }

  // Lines before the first Host or Match, and under `Host *`, apply to every host.
  let appliesToAll = true;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const keyword = parsed.keyword.toLowerCase();
    if (keyword === 'host') {
      appliesToAll = parsed.args.every(pattern => pattern === '*');
      for (const alias of parsed.args) {
        if (SAFE_ALIAS.test(alias)) context.hosts.add(alias);
      }
    } else if (keyword === 'match') {
      appliesToAll = false;
    } else if (keyword === 'include' && appliesToAll) {
      // An Include inside a narrower block only applies to that block's hosts,
      // so the hosts it defines are not reachable by a plain `ssh <alias>`.
      for (const pattern of parsed.args) {
        for (const included of await expandInclude(pattern, context)) {
          await readConfigFile(included, context);
        }
      }
    }
  }
}

/** Splits an ssh_config line into its keyword and arguments, or null for a blank, comment or malformed line. */
function parseLine(line: string): { keyword: string; args: string[] } | null {
  const match = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  const args = splitArgs(match[2]);
  return args && args.length > 0 ? { keyword: match[1], args } : null;
}

/** Whitespace-separated arguments with double-quoted values; a `#` token starts a comment. */
function splitArgs(rest: string): string[] | null {
  const args: string[] = [];
  const token = /"([^"]*)"|([^\s"]+)|(")/g;
  for (let match = token.exec(rest); match; match = token.exec(rest)) {
    if (match[3] !== undefined) return null;
    const value = match[1] ?? match[2];
    if (match[2]?.startsWith('#')) break;
    args.push(value);
  }
  return args;
}

async function expandInclude(pattern: string, { home, sshDir }: ReadContext): Promise<string[]> {
  const expanded = pattern === '~' || /^~[\\/]/.test(pattern) ? path.join(home, pattern.slice(1)) : pattern;
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded);
  const matches = await glob(absolute.split(path.sep).join('/'), {
    nodir: true,
    dot: true,
    absolute: true,
    windowsPathsNoEscape: true,
  });
  return matches.sort();
}
