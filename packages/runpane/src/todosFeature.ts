import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { resolvePaneDirectory } from './daemonClient';
import { RunpaneError } from './errors';

/**
 * To-dos is experimental and off by default (T-39): Settings > Advanced > Experimental > To-dos
 * saves `todosEnabled` in `<pane-dir>/config.json`. While it is off, `runpane todos …` and the
 * todos_* MCP tools refuse, and help, agent-context, docs and the MCP tool list carry no to-do
 * text. `--todo` on notify, report and agents start is still accepted (an agent with an older
 * prompt keeps its question) and dropped. packages/runpane-py/src/runpane/todos_feature.py mirrors this.
 */

const todosConfigSchema = boundary.object({ todosEnabled: boundary.optional(boundary.boolean) });

/** Whether To-dos is on in this Pane directory; a missing or unreadable config counts as off. */
function todosEnabled(paneDir: string): boolean {
  try {
    return decodeBoundary(JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8')), todosConfigSchema).todosEnabled === true;
  } catch {
    return false;
  }
}

/** The same, for `--pane-dir` (else PANE_DIR, else ~/.pane). */
export function todosOn(paneDir?: string): boolean {
  return todosEnabled(resolvePaneDirectory(paneDir));
}

const TODOS_DISABLED_CODE = 'TODOS_DISABLED';

export function todosDisabledError(): RunpaneError {
  return new RunpaneError(
    TODOS_DISABLED_CODE,
    'To-dos is turned off in this Pane, so nothing was read or changed. Saved to-dos are kept.',
    'Turn it on in Settings > Advanced > Experimental > To-dos, then run this again.',
  );
}

/** `todos` and every `todos <verb>`. */
export function isTodoCommand(name: string): boolean {
  return name === 'todos' || name.startsWith('todos ');
}

/** Text that is about to-dos: the commands, the `--todo` flag, or the word itself. */
const TODO_TEXT = /to-do|todos|--todo/i;
/** `[--todo <T-n>]` inside a usage line, with the space before it. */
const TODO_FLAG_USAGE = / \[--todo <T-n>\]/g;

export function mentionsTodos(text: string): boolean {
  return TODO_TEXT.test(text);
}

/** The lines with `[--todo <T-n>]` taken out of usage lines, and every line still about to-dos dropped. */
export function withoutTodoLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(TODO_FLAG_USAGE, '')).filter((line) => !mentionsTodos(line));
}

interface ContextArgument {
  name: string;
  description?: string;
}

/** An agent-context command without its `--todo` argument and its to-do examples and notes. */
export function withoutTodoArguments<A extends ContextArgument, C extends { arguments: readonly A[]; examples: readonly string[]; notes?: readonly string[] }>(command: C):
  Omit<C, 'arguments' | 'examples' | 'notes'> & { arguments: A[]; examples: string[]; notes?: string[] } {
  const { arguments: args, examples, notes, ...rest } = command;
  const result: Omit<C, 'arguments' | 'examples' | 'notes'> & { arguments: A[]; examples: string[]; notes?: string[] } = {
    ...rest,
    arguments: args.filter((argument) => !mentionsTodos(argument.name) && !mentionsTodos(argument.description ?? '')),
    examples: withoutTodoLines(examples),
  };
  if (notes) result.notes = withoutTodoLines(notes);
  return result;
}
