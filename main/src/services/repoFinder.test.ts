import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import { checkRepoFolder, codexProjectPaths, findHostRepos } from './repoFinder';

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
      ['acme-web', '~/code/acme-web', 'main', 'code_folder'],
      ['billing-api', '~/code/billing-api', 'main', 'code_folder'],
      ['mobile-app', '~/dev/mobile-app', 'develop', 'code_folder'],
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
    const main = makeRepo('code/acme-web', '2026-10-20T10:00:00Z');
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
});
