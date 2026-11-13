import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { getAppSubdirectory } from '../../utils/appDirectory';
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
 * Claude reports the conversation it is on to Pane at start, /resume, /clear and compact (D-269), with
 * Notify on or off. `runpane panels conversation --hook` reads the hook's JSON, prints nothing and always
 * exits 0; the guard keeps a shell without Pane's runpane quiet too.
 */
export const CONVERSATION_HOOK: ClaudeSettings = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', timeout: 5, command: '[ -n "$PANE_RUNPANE_BIN" ] && "$PANE_RUNPANE_BIN" panels conversation --hook >/dev/null 2>&1; exit 0' }] }],
  },
};

/**
 * A direct Claude launch in `panelId` with Pane's prompt hooks and its conversation hook, and any `extra` settings, merged
 * into the one `--settings` file Claude reads (owner-only, in Pane's app folder). A command that
 * already names that file keeps the hooks it holds. Returns the command unchanged when there is
 * nothing to add, and undefined when Pane can't merge what the command already passes or can't
 * write the file; the caller then launches its own command, without Pane's prompt hooks.
 */
export function withClaudePromptHooks(panelId: string, command: string, cwd: string, shellType: string | undefined, extra?: ClaudeSettings): string | undefined {
  const directory = getAppSubdirectory('claude-prompts');
  const file = path.join(directory, `${createHash('sha256').update(panelId).digest('hex').slice(0, 32)}.json`);
  // A command that already names the file has these hooks in it; adding them again would run them twice.
  const own = command.includes(file) ? [] : [bridge?.hookSettings(panelId), CONVERSATION_HOOK];
  const settings = [...own, extra].filter((value): value is ClaudeSettings => value !== undefined);
  if (settings.length === 0) return command;
  const merged = mergeClaudeSettingsFlag({ command, cwd, shellType, file, extra: settings.reduce(mergeClaudeSettings, {}) });
  if (!merged) {
    console.warn(`[Claude prompts] Panel ${panelId} launches without Pane's prompt hooks: its command's --settings could not be merged.`);
    return undefined;
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(merged.settings), { mode: 0o600 });
  } catch (error) {
    console.warn(`[Claude prompts] Panel ${panelId} launches without Pane's prompt hooks: ${file} could not be written (${error instanceof Error ? error.message : String(error)}).`);
    return undefined;
  }
  return merged.command;
}
