import { PaneError } from '../../../../shared/paneError';
import type { AppConfig } from '../../types/config';
import type { TodoService } from './todoService';

/**
 * To-dos is experimental and off by default (T-39). This is the one place main reads the switch
 * (Settings › Advanced › Experimental › To-dos): the IPC handlers, the supervisor and load gate,
 * agent-start hooks, and every instruction and skill Pane writes for agents ask it. Turning it off
 * hides and stops To-dos without touching the saved to-dos or their Sessions.
 */
export function todosEnabled(config: Pick<AppConfig, 'todosEnabled'> | undefined): boolean {
  return config?.todosEnabled === true;
}

let readConfig: () => Pick<AppConfig, 'todosEnabled'> | undefined = () => undefined;

/** Startup points the switch at the live config once; until then (and in tests that don't) To-dos reads as off. */
export function readTodosSwitchFrom(read: () => Pick<AppConfig, 'todosEnabled'> | undefined): void {
  readConfig = read;
}

/** The switch, for code without a config of its own at hand: Session instructions and Pane's skills. */
export function todosOn(): boolean {
  return todosEnabled(readConfig());
}

const TODOS_DISABLED_CODE = 'TODOS_DISABLED';

/** The refusal `runpane todos …`, the todos_* MCP tools and the app's To-dos channels give while it is off. */
function todosDisabledError(): PaneError {
  return new PaneError(
    TODOS_DISABLED_CODE,
    'To-dos is turned off in this Pane, so nothing was read or changed. Saved to-dos are kept.',
    'Turn it on in Settings > Advanced > Experimental > To-dos, then run this again.',
  );
}

export function requireTodosOn(config: Pick<AppConfig, 'todosEnabled'> | undefined): void {
  if (!todosEnabled(config)) throw todosDisabledError();
}

/** The to-do service while To-dos is on; undefined while it is off, so callers skip their to-do work. */
export function activeTodoService(services: { todoService?: TodoService; configManager: { getConfig(): Pick<AppConfig, 'todosEnabled'> } }): TodoService | undefined {
  return todosEnabled(services.configManager.getConfig()) ? services.todoService : undefined;
}
