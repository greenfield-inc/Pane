import fs from 'fs';
import os from 'os';
import path from 'path';
import { boundary, BoundaryDecodeError, decodeBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { PaneCommandError } from '../../core/commandError';
import type { PaneCommandRegistry, PaneCommandValue } from '../commandRegistry';
import { CLOUD_SERVE_RECORD } from './cloudSessionMarker';

/**
 * The user's defaults for agents in a Runpane Cloud Session: today the model Claude Code starts with
 * (`model` in ~/.claude/settings.json). The list lives in the user's `agentDefaults` setting on their
 * machine (`runpane cloud agent-defaults`; Pane ships none, so unset means Claude Code's own default).
 * The daemon keeps the copy it was given and applies it at every start, like the guardrail notes.
 *
 * It only ever changes a `model` it wrote itself: when Claude Code's `model` differs from the value the
 * daemon last applied (someone picked another model in the Session with `/model` or edited the file), that
 * choice is kept. Every other key in settings.json is kept as it is.
 */
const AGENT_DEFAULTS_CONFIG = path.join('.runpane-cloud', 'agent-defaults.json');
const CLAUDE_SETTINGS = path.join('.claude', 'settings.json');
/** A model id or alias as Claude Code's --model takes it, e.g. claude-opus-5-5, opus, claude-opus-5-5[1m]. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/u;

export interface AgentDefaults {
  claudeModel?: string;
}

/** What happened to Claude Code's `model` in this Session. */
export type ClaudeModelOutcome =
  | 'set'
  | 'current'
  | 'kept-session-choice'
  | 'removed'
  | 'unset'
  | 'settings-unreadable';

interface StoredAgentDefaults extends AgentDefaults {
  /** The `model` the daemon last wrote into ~/.claude/settings.json; it never changes another value. */
  appliedClaudeModel?: string;
}

export interface AgentDefaultsResult {
  claudeModel: { configured: string | null; inSettings: string | null; outcome: ClaudeModelOutcome };
  changedFiles: string[];
}

export function normalizeAgentDefaults(defaults: AgentDefaults): AgentDefaults {
  if (defaults.claudeModel === undefined) return {};
  const model = defaults.claudeModel.trim();
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(`Not a Claude model id: ${JSON.stringify(defaults.claudeModel)} (for example claude-opus-5-5 or opus).`);
  }
  return { claudeModel: model };
}

const storedSchema = boundary.object({
  claudeModel: boundary.optional(boundary.string),
  appliedClaudeModel: boundary.optional(boundary.string),
});

/** The delivered defaults; none when the file is missing or unreadable (never fatal at boot). */
function readStored(home: string): StoredAgentDefaults {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(home, AGENT_DEFAULTS_CONFIG), 'utf8'));
    const stored = decodeBoundary(parsed, storedSchema);
    return { ...normalizeAgentDefaults({ claudeModel: stored.claudeModel }), appliedClaudeModel: stored.appliedClaudeModel };
  } catch {
    return {};
  }
}

export function readAgentDefaults(home: string = os.homedir()): AgentDefaults {
  const { claudeModel } = readStored(home);
  return claudeModel === undefined ? {} : { claudeModel };
}

function writeJsonAtomic(file: string, value: JsonObject, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
}

function saveStored(home: string, stored: StoredAgentDefaults, now: Date): void {
  const record: JsonObject = { version: 1 };
  if (stored.claudeModel !== undefined) record.claudeModel = stored.claudeModel;
  if (stored.appliedClaudeModel !== undefined) record.appliedClaudeModel = stored.appliedClaudeModel;
  record.updatedAt = now.toISOString();
  writeJsonAtomic(path.join(home, AGENT_DEFAULTS_CONFIG), record, 0o600);
}

/** Claude Code's user settings; {} when the file is missing, null when it is not a JSON object. */
function readClaudeSettings(file: string): JsonObject | null {
  if (!fs.existsSync(file)) return {};
  try {
    return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.jsonObject);
  } catch {
    return null;
  }
}

/** The model a settings value names; null when it is missing or not a string. */
function modelName(value: JsonValue | undefined): string | null {
  try {
    return decodeBoundary(value, boundary.string);
  } catch {
    return null;
  }
}

interface SessionAgentDefaultsOptions {
  home?: string;
  serveRecordPath?: string;
  now?: () => Date;
}

/**
 * Applies the stored defaults to Claude Code's user settings on a Runpane Cloud Session and says what it
 * did; changes nothing off a Session. Runs at every daemon start and after each delivery. Idempotent.
 */
export function applySessionAgentDefaults(options: SessionAgentDefaultsOptions = {}): AgentDefaultsResult {
  const home = options.home ?? os.homedir();
  const stored = readStored(home);
  const configured = stored.claudeModel ?? null;
  const settingsFile = path.join(home, CLAUDE_SETTINGS);
  const result = (inSettings: JsonValue | undefined, outcome: ClaudeModelOutcome, changedFiles: string[] = []): AgentDefaultsResult => ({
    claudeModel: { configured, inSettings: modelName(inSettings), outcome },
    changedFiles,
  });
  if (!fs.existsSync(options.serveRecordPath ?? CLOUD_SERVE_RECORD)) return result(undefined, 'unset');

  const settings = readClaudeSettings(settingsFile);
  // Never rewrite a file we cannot parse: that would drop the user's other settings.
  if (settings === null) return result(undefined, 'settings-unreadable');
  const current = settings.model;
  const applied = stored.appliedClaudeModel;
  // A `model` is the daemon's to change only when it is missing or still the value the daemon wrote.
  const ours = current === undefined || (applied !== undefined && current === applied);

  let next: JsonObject | null = null;
  let nextApplied = applied;
  let outcome: ClaudeModelOutcome;
  if (configured === null) {
    if (applied !== undefined && current === applied) {
      next = { ...settings };
      delete next.model;
      nextApplied = undefined;
      outcome = 'removed';
    } else {
      outcome = 'unset';
    }
  } else if (current === configured) {
    nextApplied = configured;
    outcome = 'current';
  } else if (ours) {
    next = { ...settings, model: configured };
    nextApplied = configured;
    outcome = 'set';
  } else {
    outcome = 'kept-session-choice';
  }

  const changed: string[] = [];
  if (next) {
    // Keep the file's mode (bootstrap writes it 0600); a new file is private too.
    const mode = fs.existsSync(settingsFile) ? fs.statSync(settingsFile).mode & 0o777 : 0o600;
    writeJsonAtomic(settingsFile, next, mode);
    changed.push(settingsFile);
  }
  if (nextApplied !== applied) {
    saveStored(home, { claudeModel: stored.claudeModel, appliedClaudeModel: nextApplied }, (options.now ?? (() => new Date()))());
  }
  return result(next ? next.model : current, outcome, changed);
}

const agentDefaultsRequestSchema = boundary.object({
  defaults: boundary.optional(boundary.object({ claudeModel: boundary.optional(boundary.string) })),
});

/**
 * `runpane:cloud:agent-defaults`: without `defaults`, what this Session has; with `defaults`, stores them
 * (replacing the previous ones; `{}` clears them) and applies them now. `runpane cloud agent-defaults` on the
 * user's machine calls it with their `agentDefaults` setting. Not on the coordinator's allow-list.
 */
export function registerAgentDefaultsHandler(commandRegistry: PaneCommandRegistry, options: SessionAgentDefaultsOptions = {}): void {
  commandRegistry.register('runpane:cloud:agent-defaults', async (request: PaneCommandValue = {}) => {
    let wanted: AgentDefaults | undefined;
    try {
      const decoded = decodeBoundary(request ?? {}, agentDefaultsRequestSchema);
      wanted = decoded.defaults === undefined ? undefined : normalizeAgentDefaults(decoded.defaults);
    } catch (error) {
      const message = error instanceof BoundaryDecodeError ? error.message : error instanceof Error ? error.message : String(error);
      throw new PaneCommandError(`Invalid agent defaults request: ${message}`, 'ERR_AGENT_DEFAULTS_INVALID');
    }
    if (!fs.existsSync(options.serveRecordPath ?? CLOUD_SERVE_RECORD)) {
      throw new PaneCommandError('Agent defaults are only for Runpane Cloud Sessions (this daemon is not in one).', 'ERR_AGENT_DEFAULTS_UNAVAILABLE');
    }
    const home = options.home ?? os.homedir();
    if (wanted !== undefined) {
      const stored = readStored(home);
      saveStored(home, { ...wanted, appliedClaudeModel: stored.appliedClaudeModel }, (options.now ?? (() => new Date()))());
    }
    const applied = applySessionAgentDefaults(options);
    return { ok: true, defaults: { ...readAgentDefaults(home) }, claudeModel: { ...applied.claudeModel }, changedFiles: applied.changedFiles };
  });
}
