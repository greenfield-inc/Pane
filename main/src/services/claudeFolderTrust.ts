import fs from 'fs';
import os from 'os';
import path from 'path';
import { sessionGitCeiling } from './sessionWorkspace';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/**
 * Sets `projects[<folder>].hasTrustDialogAccepted` in Claude Code's config for
 * one Session folder, so a Session agent opens without the folder trust
 * prompt. Only folders directly inside this Pane's sessions directory
 * qualify. Every other key is kept. A missing or unreadable config is left
 * alone: Claude creates it on first run and asks once.
 */
export function trustClaudeSessionFolder(folder: string, configPath = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')): void {
  if (path.dirname(path.resolve(folder)) !== path.resolve(sessionGitCeiling())) return;
  try {
    if (!fs.existsSync(configPath)) return;
    // Write through a symlinked config (dotfiles setups) instead of replacing the link.
    const target = fs.realpathSync(configPath);
    const config = decodeBoundary(JSON.parse(fs.readFileSync(target, 'utf8')), boundary.jsonObject);
    const projects = config.projects === undefined ? {} : decodeBoundary(config.projects, boundary.jsonObject);
    // Claude matches the folder as launched and as resolved by the OS.
    const keys = new Set([path.resolve(folder), fs.realpathSync(folder)].map(key => key.normalize('NFC')));
    let changed = false;
    for (const key of keys) {
      const entry = projects[key] === undefined ? undefined : decodeBoundary(projects[key], boundary.jsonObject);
      if (entry?.hasTrustDialogAccepted === true) continue;
      projects[key] = { ...entry, hasTrustDialogAccepted: true };
      changed = true;
    }
    if (!changed) return;
    config.projects = projects;
    const temp = `${target}.pane-${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: fs.statSync(target).mode & 0o777 });
    fs.renameSync(temp, target);
  } catch (error) {
    console.warn(`[Pane] Could not pre-trust Session folder for Claude Code in ${configPath}:`, error);
  }
}
