import { boundary, decodeBoundary, type JsonObject } from '../boundaryDecoder';
import type { CloudDeps } from './commands';
import { findHost, type CloudHostRecord, type CloudSettings } from './store';

/**
 * `runpane cloud agent-defaults`: the user's defaults for agents in their cloud Sessions, today the model
 * Claude Code starts with. A per-user setting (`agentDefaults.claudeModel` in settings.json; Pane ships
 * none, so unset means Claude Code's own default). Each Session's daemon keeps the copy it was given
 * (`runpane:cloud:agent-defaults`, ~/.runpane-cloud/agent-defaults.json) and writes `model` into
 * ~/.claude/settings.json at every boot and wake, without changing a model picked in the Session.
 * `new` and `wake` hand the current defaults over; `set`, `unset` and `push` hand them to every awake Session.
 */

const AGENT_DEFAULTS_USAGE = `runpane cloud agent-defaults: your defaults for agents in every cloud Session.
  runpane cloud agent-defaults list [--json]                          the configured defaults
  runpane cloud agent-defaults set claude-model <model> [--no-push]   the model Claude Code starts with (e.g. claude-opus-5-5)
  runpane cloud agent-defaults unset claude-model [--no-push]         back to Claude Code's own default
  runpane cloud agent-defaults push [<host>] [--json]                 give a Session (default: all) the current defaults
Saved as agentDefaults in settings.json. Each Session keeps its copy and writes model into
~/.claude/settings.json at every boot and wake (a model picked in the Session with /model is kept); new and
wake push the current defaults, and an asleep Session keeps its previous ones until then.`;

const AGENT_DEFAULTS_CHANNEL = 'runpane:cloud:agent-defaults';
const PUSH_TIMEOUT_MS = 20_000;
/** A model id or alias as Claude Code's --model takes it (the daemon checks the same). */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/u;

export type AgentDefaults = NonNullable<CloudSettings['agentDefaults']>;

export type AgentDefaultsPushResult =
  | { host: string; pushed: true; claudeModel: { inSettings: string | null; outcome: string }; changedFiles: string[] }
  | { host: string; pushed: false; reason: string };

interface DefaultsCommand {
  sub: 'list' | 'set' | 'unset' | 'push';
  value?: string;
  json: boolean;
  noPush: boolean;
}

function parseDefaultsArgv(argv: readonly string[]): DefaultsCommand {
  const positional: string[] = [];
  let json = false;
  let noPush = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--no-push') noPush = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option for runpane cloud agent-defaults: ${arg}\n${AGENT_DEFAULTS_USAGE}`);
    else positional.push(arg);
  }
  const [sub = 'list', ...rest] = positional;
  if (sub !== 'list' && sub !== 'set' && sub !== 'unset' && sub !== 'push') {
    throw new Error(`Unknown agent-defaults command: ${sub}\n${AGENT_DEFAULTS_USAGE}`);
  }
  if (noPush && sub !== 'set' && sub !== 'unset') throw new Error('--no-push goes with set and unset.');
  const arity = { list: '', set: 'claude-model <model>', unset: 'claude-model', push: '[<host>]' }[sub];
  const fits = sub === 'push' ? rest.length <= 1 : rest.length === (arity ? arity.split(' ').length : 0);
  if (!fits) throw new Error(`Usage: runpane cloud agent-defaults ${sub}${arity ? ` ${arity}` : ''}\n${AGENT_DEFAULTS_USAGE}`);
  if ((sub === 'set' || sub === 'unset') && rest[0] !== 'claude-model') throw new Error(`Unknown agent default: ${rest[0] ?? ''} (the one there is: claude-model).`);
  return { sub, value: sub === 'push' ? rest[0] : rest[1], json, noPush };
}

/** The configured defaults; undefined when the user never set any (nothing is pushed then). */
export function configuredAgentDefaults(settings: CloudSettings): AgentDefaults | undefined {
  return settings.agentDefaults;
}

function checkModel(raw: string): string {
  const model = raw.trim();
  if (!MODEL_PATTERN.test(model)) throw new Error(`Not a Claude model id: ${JSON.stringify(raw)} (for example claude-opus-5-5 or opus).`);
  return model;
}

const agentDefaultsAnswerSchema = boundary.object({
  claudeModel: boundary.object({ inSettings: boundary.nullable(boundary.string), outcome: boundary.string }),
  changedFiles: boundary.array(boundary.string),
});

/** Gives one Session the defaults. Never throws: an asleep Session or an older Pane is reported. */
export async function pushAgentDefaults(record: CloudHostRecord, defaults: AgentDefaults, deps: Pick<CloudDeps, 'invokeDaemon'>): Promise<AgentDefaultsPushResult> {
  const host = record.profile.cloud.hostname;
  if (!record.profile.baseUrl || !record.profile.token) return { host, pushed: false, reason: 'its setup never finished' };
  const request: JsonObject = defaults.claudeModel === undefined ? {} : { claudeModel: defaults.claudeModel };
  try {
    const answer = decodeBoundary(
      await deps.invokeDaemon(record.profile, AGENT_DEFAULTS_CHANNEL, [{ defaults: request }], PUSH_TIMEOUT_MS),
      agentDefaultsAnswerSchema,
    );
    return { host, pushed: true, claudeModel: answer.claudeModel, changedFiles: answer.changedFiles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No Pane daemon command registered/u.test(message)) {
      return { host, pushed: false, reason: 'its Pane predates agent defaults; it gets them after its next Pane upgrade and push' };
    }
    if (/connect|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timed out|aborted/iu.test(message)) {
      return { host, pushed: false, reason: `unreachable (asleep? it gets the defaults at its next runpane cloud wake): ${message}` };
    }
    return { host, pushed: false, reason: message };
  }
}

/** One line about a push, e.g. "Claude model claude-opus-5-5 (set)". */
export function describeClaudeModel(result: AgentDefaultsPushResult): string {
  if (!result.pushed) return `not updated (${result.reason})`;
  const { inSettings, outcome } = result.claudeModel;
  if (outcome === 'kept-session-choice') return `Claude model ${inSettings ?? '?'} kept (picked in the Session; /model there changes it)`;
  if (outcome === 'settings-unreadable') return 'Claude model not set (~/.claude/settings.json is not valid JSON there)';
  return `Claude model ${inSettings ?? "Claude Code's default"} (${outcome})`;
}

export async function runAgentDefaultsCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  if (['help', '--help', '-h'].includes(argv[0] ?? '')) {
    deps.stdout(AGENT_DEFAULTS_USAGE);
    return 0;
  }
  const command = parseDefaultsArgv(argv);
  const settings = await deps.store.readSettings();
  let defaults: AgentDefaults = configuredAgentDefaults(settings) ?? {};

  if (command.sub === 'list') {
    if (command.json) deps.stdout(JSON.stringify({ ok: true, defaults }, null, 2));
    else deps.stdout(`claude-model: ${defaults.claudeModel ?? "unset (Claude Code's own default)"}`);
    return 0;
  }

  let records = await deps.store.listHosts();
  if (command.sub === 'set' || command.sub === 'unset') {
    defaults = command.sub === 'set' ? { ...defaults, claudeModel: checkModel(command.value ?? '') } : withoutClaudeModel(defaults);
    await deps.store.writeSettings({ ...settings, agentDefaults: defaults });
    if (command.noPush) records = [];
  } else if (command.value !== undefined) {
    records = [findHost(records, command.value)];
  }

  const results = await Promise.all(records.map((record) => pushAgentDefaults(record, defaults, deps)));
  if (command.json) {
    const json: JsonObject = { ok: results.every((result) => result.pushed), defaults: { ...defaults }, sessions: results };
    deps.stdout(JSON.stringify(json, null, 2));
  } else {
    if (command.sub !== 'push') deps.stdout(`runpane cloud: claude-model ${defaults.claudeModel ?? 'unset'} saved in settings.json.`);
    if (records.length > 0) deps.stdout(`Pushed to ${results.filter((result) => result.pushed).length} of ${records.length} cloud Session${records.length === 1 ? '' : 's'}:`);
    for (const result of results) deps.stdout(`  ${result.host}: ${describeClaudeModel(result)}`);
  }
  // set/unset succeeded once the setting is saved; a push names its Sessions, so any miss fails it.
  return command.sub === 'push' && results.some((result) => !result.pushed) ? 1 : 0;
}

function withoutClaudeModel(defaults: AgentDefaults): AgentDefaults {
  const rest = { ...defaults };
  delete rest.claudeModel;
  return rest;
}
