import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { findHost, type CloudHostRecord, type CloudSettings } from './store';

/**
 * `runpane cloud notes`: the user's own guardrails for agents in their cloud Sessions. The list is a
 * per-user setting (`agentNotes.guardrails` in settings.json; Pane ships none). Each Session's daemon
 * keeps the copy it was given (`runpane:cloud:agent-notes`, ~/.runpane-cloud/agent-notes.json) and
 * writes it into ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md at every boot and wake. `new` and `wake`
 * hand the current list over; `add`, `remove` and `push` hand it to every awake Session.
 */

const CLOUD_NOTES_USAGE = `runpane cloud notes: your guardrails for agents in every cloud Session.
  runpane cloud notes list [--json]                  the configured guardrails
  runpane cloud notes add "<guardrail>" [--no-push]    add one line (then push to awake Sessions)
  runpane cloud notes remove <number|text> [--no-push] remove one (then push)
  runpane cloud notes push [<host>] [--json]           give a Session (default: all) the current list
Saved as agentNotes.guardrails in settings.json. Each Session keeps its copy and writes it into
~/.claude/CLAUDE.md and ~/.codex/AGENTS.md at every boot and wake; new and wake push the current list,
and an asleep Session keeps its previous list until then.`;

const AGENT_NOTES_CHANNEL = 'runpane:cloud:agent-notes';
const PUSH_TIMEOUT_MS = 20_000;
const MAX_GUARDRAILS = 20;
const MAX_GUARDRAIL_LENGTH = 500;

export type AgentNotesPushResult =
  | { host: string; pushed: true; changedFiles: string[] }
  | { host: string; pushed: false; reason: string };

interface NotesCommand {
  sub: 'list' | 'add' | 'remove' | 'push';
  value?: string;
  json: boolean;
  noPush: boolean;
}

function parseNotesArgv(argv: readonly string[]): NotesCommand {
  const positional: string[] = [];
  let json = false;
  let noPush = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--no-push') noPush = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option for runpane cloud notes: ${arg}\n${CLOUD_NOTES_USAGE}`);
    else positional.push(arg);
  }
  const [sub = 'list', value, extra] = positional;
  if (sub !== 'list' && sub !== 'add' && sub !== 'remove' && sub !== 'push') {
    throw new Error(`Unknown notes command: ${sub}\n${CLOUD_NOTES_USAGE}`);
  }
  if (extra !== undefined || (sub === 'list' && value !== undefined)) {
    throw new Error(`Too many arguments for runpane cloud notes ${sub} (quote the guardrail).`);
  }
  if ((sub === 'add' || sub === 'remove') && value === undefined) throw new Error(`runpane cloud notes ${sub} needs a value.\n${CLOUD_NOTES_USAGE}`);
  if (noPush && sub !== 'add' && sub !== 'remove') throw new Error('--no-push goes with add and remove.');
  return { sub, value, json, noPush };
}

/** The configured guardrails; undefined when the user never set any (nothing is pushed then). */
export function configuredGuardrails(settings: CloudSettings): string[] | undefined {
  return settings.agentNotes?.guardrails;
}

/** One trimmed line, at most 500 characters, without comment markers (the daemon checks the same). */
function checkGuardrail(raw: string): string {
  const line = raw.trim();
  if (!line) throw new Error('A guardrail cannot be empty.');
  if (/[\r\n]/u.test(line)) throw new Error('A guardrail must be a single line.');
  // The Session's notes delimit blocks with HTML comments; a marker in a line would break them.
  if (line.includes('<!--') || line.includes('-->')) throw new Error('A guardrail cannot contain HTML comment markers (<!-- or -->).');
  if (line.length > MAX_GUARDRAIL_LENGTH) throw new Error(`A guardrail can be at most ${MAX_GUARDRAIL_LENGTH} characters.`);
  return line;
}

const agentNotesAnswerSchema = boundary.object({ changedFiles: boundary.array(boundary.string) });

/** Gives one Session the list. Never throws: an asleep Session or an older Pane is reported. */
export async function pushAgentNotes(record: CloudHostRecord, guardrails: readonly string[], deps: Pick<CloudDeps, 'invokeDaemon'>): Promise<AgentNotesPushResult> {
  const host = record.profile.cloud.hostname;
  if (!record.profile.baseUrl || !record.profile.token) return { host, pushed: false, reason: 'its setup never finished' };
  try {
    const answer = decodeBoundary(
      await deps.invokeDaemon(record.profile, AGENT_NOTES_CHANNEL, [{ guardrails: [...guardrails] }], PUSH_TIMEOUT_MS),
      agentNotesAnswerSchema,
    );
    return { host, pushed: true, changedFiles: answer.changedFiles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No Pane daemon command registered/u.test(message)) {
      return { host, pushed: false, reason: 'its Pane predates agent notes; it gets them after its next Pane upgrade and push' };
    }
    if (/connect|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timed out|aborted/iu.test(message)) {
      return { host, pushed: false, reason: `unreachable (asleep? it gets the list at its next runpane cloud wake): ${message}` };
    }
    return { host, pushed: false, reason: message };
  }
}

function describePush(result: AgentNotesPushResult): string {
  if (!result.pushed) return `  ${result.host}: not updated (${result.reason})`;
  return `  ${result.host}: ${result.changedFiles.length > 0 ? `updated ${result.changedFiles.join(', ')}` : 'already current'}`;
}

export async function runCloudNotesCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  if (['help', '--help', '-h'].includes(argv[0] ?? '')) {
    deps.stdout(CLOUD_NOTES_USAGE);
    return 0;
  }
  const command = parseNotesArgv(argv);
  const settings = await deps.store.readSettings();
  let guardrails = configuredGuardrails(settings) ?? [];

  if (command.sub === 'list') {
    if (command.json) deps.stdout(JSON.stringify({ ok: true, guardrails }, null, 2));
    else if (guardrails.length === 0) deps.stdout('No guardrails configured. Add one with: runpane cloud notes add "<guardrail>"');
    else guardrails.forEach((line, index) => deps.stdout(`${index + 1}. ${line}`));
    return 0;
  }

  let records = await deps.store.listHosts();
  if (command.sub === 'add' || command.sub === 'remove') {
    const value = command.value ?? '';
    if (command.sub === 'add') {
      const line = checkGuardrail(value);
      if (!guardrails.includes(line)) {
        if (guardrails.length >= MAX_GUARDRAILS) throw new Error(`At most ${MAX_GUARDRAILS} guardrails.`);
        guardrails = [...guardrails, line];
      }
    } else {
      const index = /^\d+$/u.test(value) ? Number(value) - 1 : guardrails.indexOf(value.trim());
      if (index < 0 || index >= guardrails.length) throw new Error(`No guardrail ${JSON.stringify(value)}; see runpane cloud notes list.`);
      guardrails = guardrails.filter((_, position) => position !== index);
    }
    await deps.store.writeSettings({ ...settings, agentNotes: { ...settings.agentNotes, guardrails } });
    if (command.noPush) records = [];
  } else if (command.value !== undefined) {
    records = [findHost(records, command.value)];
  }

  const results = await Promise.all(records.map((record) => pushAgentNotes(record, guardrails, deps)));
  if (command.json) {
    const json: JsonObject = { ok: results.every((result) => result.pushed), guardrails, sessions: results };
    deps.stdout(JSON.stringify(json, null, 2));
  } else {
    if (command.sub !== 'push') deps.stdout(`runpane cloud: ${guardrails.length} guardrail${guardrails.length === 1 ? '' : 's'} saved in settings.json.`);
    if (records.length > 0) deps.stdout(`Pushed to ${results.filter((result) => result.pushed).length} of ${records.length} cloud Session${records.length === 1 ? '' : 's'}:`);
    for (const result of results) deps.stdout(describePush(result));
  }
  // add/remove succeeded once the setting is saved; a push names its Sessions, so any miss fails it.
  return command.sub === 'push' && results.some((result) => !result.pushed) ? 1 : 0;
}
