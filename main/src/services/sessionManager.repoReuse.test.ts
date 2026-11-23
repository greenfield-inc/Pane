import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database';
import { AnalyticsManager } from './analyticsManager';
import { ConfigManager } from './configManager';
import { SessionManager } from './sessionManager';

type SentEvent = { eventName: string; properties: Parameters<AnalyticsManager['track']>[1] & object };

let root: string;
let database: DatabaseService;
let manager: SessionManager;
let config: ConfigManager;
let sent: SentEvent[];
let paneCount = 0;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

/** A repository whose one commit holds `bytes` bytes of file content. */
function repository(name: string, bytes: number, origin?: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, 'init', '-q');
  writeFileSync(join(path, 'data.bin'), Buffer.alloc(bytes, 1));
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'init');
  if (origin) git(path, 'remote', 'add', 'origin', origin);
  return path;
}

/** One Pane install: its own data folder, database and analytics. */
async function install(name: string): Promise<void> {
  const paneDir = join(root, name);
  mkdirSync(paneDir);
  vi.stubEnv('PANE_DIR', paneDir);
  database = new DatabaseService(join(paneDir, 'sessions.db'));
  database.initialize();
  config = new ConfigManager();
  await config.initialize();
  const analytics = new AnalyticsManager(config);
  const window: Pick<BrowserWindow, 'isDestroyed'> & { webContents: Pick<BrowserWindow['webContents'], 'send'> } = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, event: SentEvent) => { sent.push(event); } },
  };
  // SAFETY: track() reads only isDestroyed() and webContents.send from the window.
  analytics.setMainWindow(window as BrowserWindow);
  manager = new SessionManager(database, analytics);
}

async function createPane(repoPath: string): Promise<SentEvent | undefined> {
  const project = database.getAllProjects().find(saved => saved.path === repoPath)
    ?? database.createProject(`project-${paneCount}`, repoPath);
  paneCount += 1;
  const before = sent.length;
  manager.createSessionWithId(`pane-${paneCount}`, 'pane', repoPath, '', `worktree-${paneCount}`, 'ignore', project.id);
  if (!config.isAnalyticsEnabled()) {
    await new Promise(resolve => setTimeout(resolve, 500));
    return undefined;
  }
  await vi.waitFor(() => expect(sent.length).toBe(before + 1), { timeout: 5000 });
  return sent[before];
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pane-repo-reuse-'));
  sent = [];
  vi.stubEnv('DO_NOT_TRACK', '');
  vi.stubEnv('RUNPANE_TELEMETRY_DISABLED', '');
  await install('install-a');
});

afterEach(async () => {
  await manager.cleanup();
  database.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('sends the same repo_key for every Pane on one repository, and its size range', async () => {
  const repo = repository('app', 12_000_000, 'https://github.com/Acme/App.git');
  const first = await createPane(repo);
  const second = await createPane(repo);

  expect(first?.eventName).toBe('session_created');
  expect(first?.properties.repo_key).toMatch(/^[0-9a-f]{16}$/);
  expect(second?.properties.repo_key).toBe(first?.properties.repo_key);
  expect(first?.properties.repo_size).toBe('10_50mb');
});

it('gives one key to the same remote written with credentials, another scheme, host case or .git', async () => {
  const urls = [
    'https://github.com/acme/app',
    'https://user:token@GitHub.com/acme/app.git',
    'git@github.com:acme/app.git',
    'ssh://git@github.com/acme/app/',
  ];
  const keys = [];
  for (const [index, url] of urls.entries()) {
    keys.push((await createPane(repository(`clone-${index}`, 10, url)))?.properties.repo_key);
  }
  expect(new Set(keys).size).toBe(1);

  const other = await createPane(repository('other', 10, 'https://github.com/acme/other'));
  expect(other?.properties.repo_key).not.toBe(keys[0]);
});

it('gives the same repository a different key on another install', async () => {
  const url = 'https://github.com/acme/app';
  const here = await createPane(repository('here', 10, url));
  await manager.cleanup();
  database.close();
  await install('install-b');
  const there = await createPane(repository('there', 10, url));

  expect(there?.properties.repo_key).toMatch(/^[0-9a-f]{16}$/);
  expect(there?.properties.repo_key).not.toBe(here?.properties.repo_key);
});

it('leaves repo_key out without an origin remote and sends no repository name, path or secret', async () => {
  await createPane(repository('with-origin', 10, 'https://github.com/acme/private-owner'));
  const event = await createPane(repository('private-name', 10));

  expect(event?.properties).not.toHaveProperty('repo_key');
  expect(event?.properties.repo_size).toBe('under_10mb');
  const secretFile = readdirSync(join(root, 'install-a')).find(name => name.includes('secret'));
  const secret = readFileSync(join(root, 'install-a', secretFile ?? ''), 'utf8').trim();
  const payload = JSON.stringify(sent);
  expect(payload).not.toMatch(/private-name|private-owner|github\.com/);
  expect(payload).not.toContain(root);
  expect(payload).not.toContain(secret);
});

it.each([
  ['the Privacy switch', () => config.updateConfig({ analytics: { ...config.getAnalyticsSettings(), enabled: false } })],
  ['DO_NOT_TRACK=1', () => { vi.stubEnv('DO_NOT_TRACK', '1'); }],
  ['RUNPANE_TELEMETRY_DISABLED', () => { vi.stubEnv('RUNPANE_TELEMETRY_DISABLED', '1'); }],
])('sends nothing and writes no secret when %s turns analytics off', async (_name, optOut) => {
  await optOut();
  await createPane(repository('app', 10, 'https://github.com/acme/app'));

  expect(sent).toEqual([]);
  expect(readdirSync(join(root, 'install-a')).filter(name => name.includes('secret'))).toEqual([]);
});
