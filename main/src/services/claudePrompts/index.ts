import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { getAppDirectory } from '../../utils/appDirectory';
import type { ClaudePromptBridge } from './claudePromptBridge';
import { mergeClaudeSettings, mergeClaudeSettingsFlag, type ClaudeSettings } from './claudeLaunchSettings';

let bridge: ClaudePromptBridge | undefined;

/** Set once Notify starts; Claude tabs launched before then start without Pane's prompt hooks. */
export function setClaudePromptBridge(next: ClaudePromptBridge | undefined): void {
  bridge = next;
}

/** The tab's agent is gone: its hook token stops working and its open prompts expire. */
export function forgetClaudePrompts(panelId: string): void {
  bridge?.forgetPanel(panelId);
}

/**
 * A direct Claude launch in `panelId` with Pane's prompt hooks, and any `extra` settings, merged
 * into the one `--settings` file Claude reads (owner-only, in Pane's app folder). Returns the
 * command unchanged when there is nothing to add or Pane can't merge what the command already
 * passes; that tab then answers its prompts only in the terminal.
 */
export function withClaudePromptHooks(panelId: string, command: string, cwd: string, shellType: string | undefined, extra?: ClaudeSettings): string {
  const settings = [bridge?.hookSettings(panelId), extra].filter((value): value is ClaudeSettings => value !== undefined);
  if (settings.length === 0) return command;
  const directory = path.join(getAppDirectory(), 'claude-prompts');
  const file = path.join(directory, `${createHash('sha256').update(panelId).digest('hex').slice(0, 32)}.json`);
  const merged = mergeClaudeSettingsFlag({ command, cwd, shellType, file, extra: settings.reduce(mergeClaudeSettings, {}) });
  if (!merged) {
    console.warn(`[Claude prompts] Panel ${panelId} launches without Pane's prompt hooks: its command's --settings could not be merged.`);
    return command;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(merged.settings), { mode: 0o600 });
  return merged.command;
}
