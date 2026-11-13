export interface BuiltInIde {
  key: string;
  label: string;
  command: string;
}

export const BUILT_IN_IDES: readonly BuiltInIde[] = [
  { key: 'vscode', label: 'VS Code', command: 'code .' },
  { key: 'cursor', label: 'Cursor', command: 'cursor .' },
];

export type ConfiguredIdeSource = 'project' | 'app';

export interface ConfiguredIde {
  command: string;
  source: ConfiguredIdeSource;
}

function present(command: string | null | undefined): string | undefined {
  const trimmed = command?.trim();
  return trimmed ? trimmed : undefined;
}

/** The project's own IDE command wins; otherwise the app-wide default applies to every project. */
export function configuredIde(
  projectCommand: string | null | undefined,
  defaultCommand: string | null | undefined,
): ConfiguredIde | undefined {
  const project = present(projectCommand);
  if (project) return { command: project, source: 'project' };
  const app = present(defaultCommand);
  if (app) return { command: app, source: 'app' };
  return undefined;
}

/** A built-in IDE key picks that IDE; no key (or an unknown one) opens the configured IDE. */
export function resolveIdeCommand(
  ideKey: string | undefined,
  projectCommand: string | null | undefined,
  defaultCommand: string | null | undefined,
): string | undefined {
  const builtIn = BUILT_IN_IDES.find((ide) => ide.key === ideKey);
  return builtIn?.command ?? configuredIde(projectCommand, defaultCommand)?.command;
}

export function isBuiltInIdeCommand(command: string): boolean {
  return BUILT_IN_IDES.some((ide) => ide.command === command.trim());
}

export interface ProjectIdeSharing {
  projectCommand: string;
  /** "Use for all projects" when the dialog opened. */
  wasShared: boolean;
  /** "Use for all projects" now. */
  shared: boolean;
  currentDefault: string | null | undefined;
}

/**
 * The app-wide default after saving a project's IDE command, or undefined to leave it unchanged ('' clears it).
 * Only the toggle changes the default: turning it on shares the project's command, and turning it off clears it.
 */
export function nextDefaultIdeCommand({ projectCommand, wasShared, shared, currentDefault }: ProjectIdeSharing): string | undefined {
  const project = present(projectCommand);
  const current = present(currentDefault);
  if (shared) return project && project !== current ? project : undefined;
  return wasShared && current ? '' : undefined;
}
