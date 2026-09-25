import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RUNPANE_CONTRACT } from './generated/contract';
import { buildPaneLink } from './links';

interface DaemonAction {
  channel: string;
  args: readonly string[];
}

/** The contract command's `daemonAction`, when it has one. */
export function daemonActionFor(command: string): DaemonAction | undefined {
  for (const entry of RUNPANE_CONTRACT.commands) {
    if (entry.name === command && 'daemonAction' in entry) return entry.daemonAction;
  }
  return undefined;
}

// The flags a daemonAction may pass, and where the parser stores each one.
const FLAG_VALUES = new Map<string, (parsed: ParsedArgs) => string | number | undefined>([
  ['--pane', (parsed) => parsed.paneId],
  ['--panel', (parsed) => parsed.panelId],
  ['--message', (parsed) => parsed.message],
  ['--url', (parsed) => parsed.url],
  ['--name', (parsed) => parsed.name],
  ['--folder', (parsed) => parsed.folder],
  ['--repo', (parsed) => repoId(parsed.repo)],
]);

/** App channels take the numeric repository id. */
function repoId(repo: string | undefined): number | undefined {
  if (repo === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(repo)) throw new Error('--repo must be a numeric repository id. Run `runpane repos list` to find it.');
  return Number(repo);
}

/**
 * Runs a contract command that maps straight onto a Pane daemon channel (the same
 * channel the app's button uses) and prints `{ ok, data, error }`.
 */
export async function runDaemonAction(parsed: ParsedArgs, action: DaemonAction): Promise<number> {
  const args = action.args.map((flag) => {
    const value = FLAG_VALUES.get(flag)?.(parsed);
    if (value === undefined) throw new Error(`runpane ${parsed.command} requires ${flag}.`);
    return value;
  });
  if (isMutating(parsed.command)) await confirmMutation(parsed);
  const response = await invokeDaemon(action.channel, args, boundary.json, { paneDir: parsed.paneDir });
  const result = normalizeResponse(response);
  // A destructive change to a Pane comes back with a link the user can open to review it.
  if (result.ok && parsed.paneId && isMutating(parsed.command) && !isAdditive(parsed.command)) {
    result.link = buildPaneLink({ kind: 'pane', id: parsed.paneId });
  }
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(result.data === undefined ? 'Done.' : JSON.stringify(result.data, null, 2));
  } else {
    console.error(result.error?.message ?? 'Failed.');
  }
  return result.ok ? 0 : 1;
}

interface DaemonActionResult {
  ok: boolean;
  data?: JsonValue;
  error?: { message: string };
  link?: string;
}

/** App handlers answer `{ success, data?, error? }` or `{ success, ...fields }`. */
function normalizeResponse(response: JsonValue): DaemonActionResult {
  let object: JsonObject;
  try {
    object = decodeBoundary(response ?? {}, boundary.jsonObject);
  } catch {
    return { ok: true, data: response };
  }
  const { success, error, data, ...rest } = object;
  const result: DaemonActionResult = { ok: success !== false };
  const payload = data !== undefined ? data : Object.keys(rest).length > 0 ? rest : undefined;
  if (payload !== undefined) result.data = payload;
  if (!result.ok) result.error = { message: error === undefined || error === null ? 'Pane reported a failure.' : String(error) };
  return result;
}

function isMutating(command: string): boolean {
  return RUNPANE_CONTRACT.commands.some((entry) => entry.name === command && 'mutates' in entry && entry.mutates === true);
}

function isAdditive(command: string): boolean {
  return RUNPANE_CONTRACT.commands.some((entry) => entry.name === command && 'additive' in entry && entry.additive === true);
}

/** Mutating commands need --yes outside an interactive terminal, like every runpane mutation. */
export async function confirmMutation(parsed: ParsedArgs): Promise<void> {
  if (parsed.yes) return;
  if (parsed.json || !input.isTTY || !output.isTTY) {
    throw new Error(`runpane ${parsed.command} mutates Pane state. Rerun with --yes in non-interactive shells.`);
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Run ${parsed.command}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new Error('Cancelled.');
  } finally {
    rl.close();
  }
}
