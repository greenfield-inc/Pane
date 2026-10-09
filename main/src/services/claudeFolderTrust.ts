import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { sessionGitCeiling } from './sessionWorkspace';
import { boundary, decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';

// Claude Code (checked in 2.1.295) saves its config under proper-lockfile: it
// creates the directory `<config path>.lock` (the path as given, not the
// symlink target), refreshes its mtime every 5 s, and treats a lock older than
// 10 s as stale. Pane takes the same lock. An experimental Claude storage
// backend writes without that lock, so Pane also re-reads just before the
// rename and retries when the file changed.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const WRITE_ATTEMPTS = 3;

type Release = () => Promise<void>;

async function lockClaudeConfig(configPath: string): Promise<Release | undefined> {
  const lock = `${configPath}.lock`;
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    const outcome = await fs.promises.mkdir(lock).then(() => 'locked', (error: NodeJS.ErrnoException) => error.code === 'EEXIST' ? 'busy' : 'failed');
    if (outcome === 'locked') return () => fs.promises.rmdir(lock).catch(() => undefined);
    if (outcome === 'failed') return undefined;
    const stale = await fs.promises.stat(lock).then(stat => stat.mtimeMs < Date.now() - LOCK_STALE_MS, () => false);
    if (stale) {
      await fs.promises.rmdir(lock).catch(() => undefined);
      continue;
    }
    if (attempt < LOCK_RETRY_DELAYS_MS.length) await sleep(LOCK_RETRY_DELAYS_MS[attempt]);
  }
  return undefined;
}

function readIfExists(file: string): Promise<string | undefined> {
  return fs.promises.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

// Claude tells the person how to restore a missing config from its backups.
// Creating a config would hide that message.
async function hasClaudeBackup(configPath: string): Promise<boolean> {
  const prefix = `${path.basename(configPath)}.backup.`;
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const dir of [path.join(claudeHome, 'backups'), path.dirname(configPath)]) {
    const names = await fs.promises.readdir(dir).catch(() => []);
    if (names.some(name => name.startsWith(prefix))) return true;
  }
  return false;
}

function trustAll(projects: JsonObject, keys: string[]): boolean {
  let changed = false;
  for (const key of keys) {
    const entry = projects[key] === undefined ? undefined : decodeBoundary(projects[key], boundary.jsonObject);
    if (entry?.hasTrustDialogAccepted === true) continue;
    projects[key] = { ...entry, hasTrustDialogAccepted: true };
    changed = true;
  }
  return changed;
}

/** Returns false when another writer changed the config during the attempt. */
async function writeTrust(keys: string[], configPath: string): Promise<boolean> {
  const missing = await fs.promises.lstat(configPath).then(() => false, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return true;
    throw error;
  });
  if (missing) {
    if (await hasClaudeBackup(configPath)) return true;
    const projects: JsonObject = {};
    trustAll(projects, keys);
    const temp = `${configPath}.pane-${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify({ projects }, null, 2), { mode: 0o600 });
    try {
      // link() publishes the complete file and fails if another writer created one.
      return await fs.promises.link(temp, configPath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false;
        throw error;
      });
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
  }

  // Write through a symlinked config (dotfiles setups) instead of replacing the link.
  const target = await fs.promises.realpath(configPath);
  const text = await fs.promises.readFile(target, 'utf8');
  const config = decodeBoundary(JSON.parse(text), boundary.jsonObject);
  const projects = config.projects === undefined ? {} : decodeBoundary(config.projects, boundary.jsonObject);
  if (!trustAll(projects, keys)) return true;
  config.projects = projects;
  const temp = `${target}.pane-${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(config, null, 2), { mode: (await fs.promises.stat(target)).mode & 0o777 });
  if (await readIfExists(target) !== text) {
    await fs.promises.rm(temp, { force: true });
    return false;
  }
  await fs.promises.rename(temp, target);
  return true;
}

/**
 * Sets `projects[<folder>].hasTrustDialogAccepted` in Claude Code's config for
 * one Session folder, so a Session agent opens without the folder trust
 * prompt. Only folders directly inside this Pane's sessions directory
 * qualify. Every other key is kept. A missing config is created with only
 * this entry; Claude fills in its defaults and still runs onboarding. A
 * malformed or unreadable config, or one whose lock stays busy, is left alone
 * and Claude asks once.
 */
export async function trustClaudeSessionFolder(folder: string, configPath = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')): Promise<void> {
  if (path.dirname(path.resolve(folder)) !== path.resolve(sessionGitCeiling())) return;
  try {
    // Claude matches the folder as launched and as resolved by the OS.
    const keys = [...new Set([path.resolve(folder), fs.realpathSync(folder)].map(key => key.normalize('NFC')))];
    const release = await lockClaudeConfig(configPath);
    if (!release) {
      console.warn(`[Pane] Claude Code's config lock ${configPath}.lock stayed busy; not pre-trusting the Session folder`);
      return;
    }
    try {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        if (await writeTrust(keys, configPath)) return;
      }
      console.warn(`[Pane] ${configPath} kept changing; not pre-trusting the Session folder`);
    } finally {
      await release();
    }
  } catch (error) {
    console.warn(`[Pane] Could not pre-trust Session folder for Claude Code in ${configPath}:`, error);
  }
}
