import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

/** Claude Code's global config, where it records the folders a person trusted. */
function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || os.homedir(), '.claude.json');
}

/**
 * Mark a folder trusted the way Claude Code's folder-trust prompt does: it sets
 * `projects[<folder>].hasTrustDialogAccepted` in its global config. Claude has
 * no command for this, so the file is merged, never rewritten from scratch:
 * every other key is kept, and the write goes to a temporary file that
 * replaces the config in one rename. A config Pane cannot read as JSON is left
 * alone. Returns whether the folder needed trusting.
 *
 * Used only for Pane's own Session folders, which hold no project code.
 */
export async function trustClaudeFolder(folder: string, configPath = claudeConfigPath()): Promise<boolean> {
  // Claude keys projects by path with forward slashes, also on Windows.
  const key = process.platform === 'win32' ? folder.replace(/\\/g, '/') : folder;
  let config: JsonObject = {};
  let mode = 0o600;
  try {
    const text = await fs.readFile(configPath, 'utf8');
    // A config that is not a JSON object throws here, and is left untouched.
    config = decodeBoundary(JSON.parse(text), boundary.jsonObject);
    mode = (await fs.stat(configPath)).mode & 0o777;
  } catch (error) {
    // A missing config is a first run: start from an empty one.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  // An entry that is not an object throws, so a config Pane does not understand is never rewritten.
  const projects = config.projects === undefined ? {} : decodeBoundary(config.projects, boundary.jsonObject);
  const project = projects[key] === undefined ? {} : decodeBoundary(projects[key], boundary.jsonObject);
  if (project.hasTrustDialogAccepted === true) return false;
  const next = { ...config, projects: { ...projects, [key]: { ...project, hasTrustDialogAccepted: true } } };
  const temporary = `${configPath}.pane-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
    await fs.rename(temporary, configPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return true;
}
