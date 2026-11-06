import { watch, type FSWatcher } from 'fs';
import os from 'os';
import { claudeConfigDir } from '../../../packages/runpane/src/cloud/claudeDefaults';

const DEFAULT_DEBOUNCE_MS = 750;

interface ClaudeSettingsWatchOptions {
  /** Default: Claude Code's user config folder for this process (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  dir?: string;
  debounceMs?: number;
}

/**
 * Calls `onChange` once a burst of changes to Claude Code's user settings.json settles. It only signals; the
 * caller re-reads whatever it needs, and nothing here ever writes the file. Returns a function that stops watching.
 */
export function watchClaudeSettings(onChange: () => void, options: ClaudeSettingsWatchOptions = {}): () => void {
  const dir = options.dir ?? claudeConfigDir(process.env, os.homedir());
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const stop = () => {
    clearTimeout(timer);
    watcher?.close();
    watcher = undefined;
  };

  try {
    // The folder, not the file: editors and Claude Code replace settings.json instead of writing it in place,
    // which ends a watch on the file itself.
    watcher = watch(dir, (_event, fileName) => {
      if (fileName && fileName.toString() !== 'settings.json') return;
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
    watcher.on('error', stop);
  } catch (cause) {
    // No folder yet means no settings to follow; connects and refreshes still pick up a default later.
    console.warn(`[CloudSandboxes] Not watching ${dir} for Claude default model changes:`, cause instanceof Error ? cause.message : 'watch failed');
  }
  return stop;
}
