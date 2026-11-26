import type { CustomCommandResume } from '../../../../shared/types/customCommandResume';
import type { AppConfig } from '../../types/config';

/**
 * The resume template a Session made in Create New starts with (T-63 build 8). Create New has no
 * resume options: Pane reconnects a chat Session itself, and Agent Farm resumes a profile or plain
 * Claude/Codex. Only a custom launch command needs a template, and it comes from Settings: the
 * saved custom command's own, or Session defaults' for the Session defaults command.
 */
export function settingsResume(
  config: Pick<AppConfig, 'defaultSessionCommand' | 'defaultSessionResume' | 'customCommands'> | null,
  launchCommand: string,
): CustomCommandResume | null {
  const command = launchCommand.trim();
  if (!command || !config) return null;
  const saved = config.customCommands?.find(item => item.command.trim() === command);
  if (saved) return saved.resume ?? null;
  if ((config.defaultSessionCommand ?? '').trim() === command) return config.defaultSessionResume ?? null;
  return null;
}
