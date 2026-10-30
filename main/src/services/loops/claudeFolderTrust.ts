import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

/** Claude Code's global config, where it records the folders a person trusted. */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || home, '.claude.json');
}

/** Claude Code's user settings, where it records that the person accepted bypass-permissions mode. */
export function claudeUserSettingsPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'), 'settings.json');
}

/**
 * Merges a change into one of Claude Code's JSON files, never rewriting it from
 * scratch: every other key is kept, and the write goes to a temporary file
 * that replaces the original in one rename. A file Pane cannot read as a JSON
 * object is left alone (this throws). A missing file is a first run. `change`
 * returns the next contents, or undefined when nothing needs writing.
 */
async function mergeClaudeJson(file: string, change: (current: JsonObject) => JsonObject | undefined): Promise<boolean> {
  let current: JsonObject = {};
  let mode = 0o600;
  try {
    const text = await fs.readFile(file, 'utf8');
    current = decodeBoundary(JSON.parse(text), boundary.jsonObject);
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const next = change(current);
  if (!next) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.pane-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return true;
}

/**
 * Mark a folder trusted the way Claude Code's folder-trust prompt does: it sets
 * `projects[<folder>].hasTrustDialogAccepted` in its global config. Claude has
 * no command for this. Returns whether the folder needed trusting.
 *
 * Used only for Pane's own Session folders, which hold no project code.
 */
export async function trustClaudeFolder(folder: string, configPath = claudeConfigPath()): Promise<boolean> {
  // Claude keys projects by path with forward slashes, also on Windows.
  const key = process.platform === 'win32' ? folder.replace(/\\/g, '/') : folder;
  return mergeClaudeJson(configPath, config => {
    // An entry that is not an object throws, so a config Pane does not understand is never rewritten.
    const projects = config.projects === undefined ? {} : decodeBoundary(config.projects, boundary.jsonObject);
    const project = projects[key] === undefined ? {} : decodeBoundary(projects[key], boundary.jsonObject);
    if (project.hasTrustDialogAccepted === true) return undefined;
    return { ...config, projects: { ...projects, [key]: { ...project, hasTrustDialogAccepted: true } } };
  });
}

/**
 * Record what Claude Code records when the person accepts its one-time
 * bypass-permissions warning (`skipDangerousModePermissionPrompt` in its user
 * settings), so the warning never stops a Claude tab Pane starts with
 * `--dangerously-skip-permissions`. The first-run screen calls this when the
 * person picks Claude Code, after telling them Pane runs it with permission
 * prompts off (D-19). Returns whether it needed recording.
 */
export async function acceptClaudeBypassPermissions(settingsPath = claudeUserSettingsPath()): Promise<boolean> {
  return mergeClaudeJson(settingsPath, settings => settings.skipDangerousModePermissionPrompt === true
    ? undefined
    : { ...settings, skipDangerousModePermissionPrompt: true });
}
