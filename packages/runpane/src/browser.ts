import { boundary, decodeBoundary, type JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';
import { refuseTeammate } from './secrets';

// `runpane browser`: the browser tabs of the calling tab's Pane (docs/BROWSER_AGENTS.md).
// Pane fills in the Pane from the caller and checks every request; nothing here names a Pane.

/** The browser commands, and the flags each one takes. */
export const BROWSER_VERBS = ['open', 'tabs', 'close', 'snapshot', 'screenshot', 'click', 'type', 'fill', 'press', 'select', 'scroll', 'navigate', 'wait', 'dialog', 'evaluate', 'upload'] as const;

/** Flags that take a value, by request field. Numbers and JSON arrays are parsed here; Pane checks the rest. */
export const BROWSER_VALUE_FLAGS = new Map<string, { field: string; kind: 'text' | 'number' | 'list' }>([
  ['--tab', { field: 'tab', kind: 'text' }],
  ['--url', { field: 'url', kind: 'text' }],
  ['--ref', { field: 'ref', kind: 'text' }],
  ['--x', { field: 'x', kind: 'number' }],
  ['--y', { field: 'y', kind: 'number' }],
  ['--button', { field: 'button', kind: 'text' }],
  ['--text', { field: 'text', kind: 'text' }],
  // `browser fill` names a saved login; its value never passes through here.
  ['--project', { field: 'project', kind: 'text' }],
  ['--name', { field: 'name', kind: 'text' }],
  ['--key', { field: 'key', kind: 'text' }],
  ['--values', { field: 'values', kind: 'list' }],
  ['--dx', { field: 'dx', kind: 'number' }],
  ['--dy', { field: 'dy', kind: 'number' }],
  ['--timeout-ms', { field: 'timeoutMs', kind: 'number' }],
  ['--expression', { field: 'expression', kind: 'text' }],
  ['--paths', { field: 'paths', kind: 'list' }],
]);

export const BROWSER_BOOLEAN_FLAGS = new Map<string, string>([
  ['--full-page', 'fullPage'],
  ['--double', 'double'],
  ['--clear', 'clear'],
  ['--submit', 'submit'],
  ['--back', 'back'],
  ['--forward', 'forward'],
  ['--reload', 'reload'],
  ['--accept', 'accept'],
  ['--dismiss', 'dismiss'],
]);

export type BrowserRequest = Record<string, string | number | boolean | string[]>;

/** Reads one browser flag's value into the request, or throws when it is malformed. */
export function setBrowserFlag(request: BrowserRequest, flag: string, value: string): void {
  const spec = BROWSER_VALUE_FLAGS.get(flag);
  if (!spec) return;
  if (spec.kind === 'number') {
    const number = Number(value);
    if (value.trim() === '' || !Number.isFinite(number)) throw new RunpaneError('ERR_BROWSER_INVALID_REQUEST', `${flag} takes a number, not "${value}". Nothing ran.`, `Pass a number, such as ${flag} 120.`);
    request[spec.field] = number;
    return;
  }
  if (spec.kind === 'list') {
    const earlier = request[spec.field];
    request[spec.field] = [...(Array.isArray(earlier) ? earlier : []), ...listValue(flag, value)];
    return;
  }
  request[spec.field] = value;
}

/** A JSON array of strings (what an MCP call sends), or one plain value. */
function listValue(flag: string, value: string): string[] {
  if (!value.trimStart().startsWith('[')) return [value];
  try {
    return decodeBoundary(JSON.parse(value), boundary.array(boundary.string));
  } catch {
    throw new RunpaneError('ERR_BROWSER_INVALID_REQUEST', `${flag} takes a JSON array of strings or one value, and "${value}" is neither. Nothing ran.`, `Pass ${flag} '["first","second"]'.`);
  }
}

/** Screenshots, evaluate and waits can take a while; a call also waits while the person drives (4 minutes). */
const CALL_TIMEOUT_MS = 5 * 60_000;

const textFields = boundary.object({ snapshot: boundary.optional(boundary.string), path: boundary.optional(boundary.string), tabs: boundary.optional(boundary.json), value: boundary.optional(boundary.json) });
const tabResult = boundary.object({ tab: boundary.optional(boundary.string), url: boundary.optional(boundary.string), title: boundary.optional(boundary.string) });

export async function runBrowser(parsed: ParsedArgs): Promise<number> {
  const verb = parsed.command.slice('browser '.length);
  if (verb === 'fill') refuseTeammate('fill a saved login');
  const request = parsed.browserRequest ?? {};
  const result = await invokeDaemon(`runpane:browser:${verb}`, [request], boundary.json, { paneDir: parsed.paneDir, timeoutMs: CALL_TIMEOUT_MS });
  console.log(parsed.json ? JSON.stringify(result, null, 2) : humanText(verb, result));
  return 0;
}

/** What a person reading the terminal wants from each result. */
function humanText(verb: string, result: JsonValue): string {
  // Every browser result is an object with these optional fields.
  const fields = decodeBoundary(result, textFields);
  if (verb === 'snapshot' && fields.snapshot !== undefined) return fields.snapshot;
  if (verb === 'screenshot' && fields.path !== undefined) return fields.path;
  if (verb === 'tabs' || verb === 'evaluate') return JSON.stringify(verb === 'tabs' ? fields.tabs : fields.value, null, 2);
  const tab = decodeBoundary(result, tabResult);
  return [tab.tab, tab.url, tab.title].filter(Boolean).join('\t');
}
