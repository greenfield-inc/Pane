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

/**
 * The Session defaults a launch command you changed in Create New becomes (#1762 F-1). The command
 * and its template are saved together, the template being the one this Session started with, so
 * a remembered command never keeps another command's template, which can name that command.
 */
export function rememberedLaunchDefaults(
  config: Pick<AppConfig, 'defaultSessionCommand' | 'defaultSessionResume'> | null,
  launchCommand: string,
  resume: CustomCommandResume | null,
): Pick<AppConfig, 'defaultSessionCommand' | 'defaultSessionResume'> | null {
  if ((config?.defaultSessionCommand ?? '') === launchCommand) return null;
  return { defaultSessionCommand: launchCommand, defaultSessionResume: resume };
}
