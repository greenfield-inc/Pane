import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import { checkRepoFolder, codexProjectPaths, findHostRepos, findWslRepos } from './repoFinder';

let home: string;

function git(cwd: string, args: string[], date?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  execFileSync('git', args, { cwd, env, stdio: 'ignore' });
}

/** Creates a repo at home/<relative> with one commit at `date` on `branch`. */
function makeRepo(relative: string, date: string, branch = 'main'): string {
  const dir = path.join(home, relative);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init'], date);
  return dir;
}

beforeEach(() => {
  // realpath: macOS tmpdir is a /var -> /private/var symlink and git prints the real path.
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repo-finder-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, ...extra });
// Generous, so a loaded CI machine doesn't spend the real 3 s budget; the budget has its own test.
const budgetMs = 60_000;

describe('findHostRepos', () => {
  it('lists code-folder repos newest commit first with branch, time and a ~ path', async () => {
    makeRepo('code/acme-web', '2026-10-26T10:00:00Z');
    makeRepo('code/billing-api', '2026-10-25T10:00:00Z');
    makeRepo('dev/mobile-app', '2026-10-22T10:00:00Z', 'develop');
    mkdirSync(path.join(home, 'code', 'not-a-repo'));

    const repos = await findHostRepos({ home, env: env(), budgetMs });

    expect(repos.map(repo => [repo.name, repo.displayPath, repo.branch, repo.source])).toEqual([
      ['acme-web', path.join('~', 'code', 'acme-web'), 'main', 'code_folder'],
      ['billing-api', path.join('~', 'code', 'billing-api'), 'main', 'code_folder'],
      ['mobile-app', path.join('~', 'dev', 'mobile-app'), 'develop', 'code_folder'],
    ]);
    expect(repos[0].path).toBe(path.join(home, 'code', 'acme-web'));
    expect(repos[0].lastCommitAt).toBe(Date.parse('2026-10-26T10:00:00Z'));
  });

  it('keeps the five newest', async () => {
    for (let day = 1; day <= 7; day++) makeRepo(`code/repo-${day}`, `2026-10-0${day}T10:00:00Z`);

    const repos = await findHostRepos({ home, env: env(), budgetMs });

    expect(repos.map(repo => repo.name)).toEqual(['repo-7', 'repo-6', 'repo-5', 'repo-4', 'repo-3']);
  });

  it('adds projects from Claude Code and Codex config outside code folders, crediting the first source', async () => {
    const fromClaude = makeRepo('elsewhere/from-claude', '2026-10-20T10:00:00Z');
    const fromCodex = makeRepo('elsewhere/from-codex', '2026-10-19T10:00:00Z');
    const inBoth = makeRepo('code/in-both', '2026-10-18T10:00:00Z');
    const claudeDir = path.join(home, 'claude-config');
    mkdirSync(claudeDir);
    writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({
      projects: { [fromClaude]: {}, [inBoth]: {}, [path.join(home, 'gone')]: {} },
    }));
    mkdirSync(path.join(home, '.codex'));
    writeFileSync(path.join(home, '.codex', 'config.toml'), `model = "x"\n\n[projects."${fromCodex}"]\ntrust_level = "trusted"\n`);

    const repos = await findHostRepos({ home, env: env({ CLAUDE_CONFIG_DIR: claudeDir }), budgetMs });

    expect(repos.map(repo => [repo.name, repo.source])).toEqual([
      ['from-claude', 'claude_config'],
      ['from-codex', 'codex_config'],
      ['in-both', 'claude_config'],
    ]);
  });

  it('counts a linked worktree as its repo and leaves out excluded repos and home', async () => {
    // Outside the code folders, so only the worktree's config key can find it.
    const main = makeRepo('elsewhere/acme-web', '2026-10-20T10:00:00Z');
    git(main, ['worktree', 'add', '-q', '-b', 'feature', path.join(main, 'worktrees', 'feature')]);
    const sample = makeRepo('pane-data/projects/Pane', '2026-10-26T10:00:00Z');
    git(home, ['init', '-q']);
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      projects: { [path.join(main, 'worktrees', 'feature')]: {}, [sample]: {}, [home]: {} },
    }));

    const repos = await findHostRepos({ home, env: env(), excluded: [sample], budgetMs });

    expect(repos.map(repo => [repo.name, repo.path])).toEqual([['acme-web', main]]);
  });

  it('returns what it has when the time budget is spent', async () => {
    makeRepo('code/acme-web', '2026-10-20T10:00:00Z');

    const started = Date.now();
    const repos = await findHostRepos({ home, env: env(), budgetMs: 0 });

    expect(repos).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// Real WSL runs `wsl.exe -d <distro> --exec bash -lc <script>` as bash with that argv.
// This stand-in does the same on macOS and Linux; Windows has the real wsl.exe.
describe.skipIf(process.platform === 'win32')('findWslRepos', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists the distro repos as UNC paths and names the agents on its PATH', async () => {
    const bin = path.join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'wsl.exe'), '#!/bin/sh\n[ "$1 $3" = "-d --exec" ] || exit 1\nshift 3\nexec "$@"\n');
    writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\n');
    chmodSync(path.join(bin, 'wsl.exe'), 0o755);
    chmodSync(path.join(bin, 'opencode'), 0o755);
    makeRepo('dev/acme-web', '2026-10-26T10:00:00Z');
    const fromClaude = makeRepo('elsewhere/infra', '2026-10-25T10:00:00Z', 'develop');
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [fromClaude]: {} } }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);

    const result = await findWslRepos('Ubuntu', { budgetMs });

    expect(result.agents).toContain('OpenCode');
    expect(result.repos.map(repo => [repo.name, repo.path, repo.displayPath, repo.branch, repo.source])).toEqual([
      ['acme-web', `\\\\wsl.localhost\\Ubuntu${path.join(home, 'dev', 'acme-web').replace(/\//g, '\\')}`, '~/dev/acme-web', 'main', 'code_folder'],
      ['infra', `\\\\wsl.localhost\\Ubuntu${fromClaude.replace(/\//g, '\\')}`, '~/elsewhere/infra', 'develop', 'claude_config'],
    ]);
  });
});

describe('codexProjectPaths', () => {
  it('unescapes Windows paths in basic strings and reads literal strings', () => {
    expect(codexProjectPaths('[projects."C:\\\\Users\\\\dev\\\\code\\\\acme"]\n[projects.\'/home/dev/code/infra\']\n')).toEqual([
      'C:\\Users\\dev\\code\\acme',
      '/home/dev/code/infra',
    ]);
  });
});

describe('checkRepoFolder', () => {
  it('accepts a Git repo', async () => {
    const repo = makeRepo('code/acme-web', '2026-10-20T10:00:00Z');

    await expect(checkRepoFolder(repo)).resolves.toEqual({ name: 'acme-web', path: repo });
  });

  it('refuses a plain folder and leaves it untouched', async () => {
    const folder = path.join(home, 'Documents');
    mkdirSync(folder);

    const error = await checkRepoFolder(folder).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PaneError);
    expect(error).toMatchObject({ code: 'ONBOARDING_NOT_A_REPO', message: "That folder isn't a Git repo." });
    expect(existsSync(path.join(folder, '.git'))).toBe(false);
  });

  it('refuses a plain folder inside a repo at home, such as dotfiles', async () => {
    git(home, ['init', '-q']);
    const folder = path.join(home, 'Documents');
    mkdirSync(folder);

    await expect(checkRepoFolder(folder, home)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_A_REPO' });
  });
});
