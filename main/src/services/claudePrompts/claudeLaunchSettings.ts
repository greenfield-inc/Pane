import { readFileSync } from 'fs';
import path from 'path';
import { tokenizeShellCommand } from '../agents/agentIdentity';
import { quoteShellWord } from '../agents/shellWord';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/** A Claude Code settings object, as `--settings` takes it. */
export type ClaudeSettings = JsonObject;

const CLAUDE_EXECUTABLE = /(?:^|[\\/])claude(?:\.exe|\.cmd)?$/i;

/**
 * The command with exactly one `--settings`, naming `file`, and the settings to write there:
 * every `--settings` the command already passed (a JSON value or a file), then `extra`.
 * Claude Code keeps only the last `--settings` flag it is given (measured on 2.1.314), so Pane
 * merges them instead of adding its own. Undefined when the command can't be rewritten without
 * changing what it asks for: unknown shell syntax, a command that doesn't start with `claude`,
 * a settings value Pane can't read, or a file path this shell can't quote.
 */
export function mergeClaudeSettingsFlag(input: {
  command: string;
  cwd: string;
  shellType: string | undefined;
  file: string;
  extra: ClaudeSettings;
}): { command: string; settings: ClaudeSettings } | undefined {
  const spans: Array<{ start: number; end: number }> = [];
  const tokens = tokenizeShellCommand(input.command, process.platform, spans);
  if (!tokens) return undefined;
  // Only a command that runs Claude itself: a wrapper's own flags are its business.
  if (!CLAUDE_EXECUTABLE.test(tokens[0] ?? '')) return undefined;
  const fileWord = quoteShellWord(input.file, input.shellType);
  if (!fileWord) return undefined;

  const values: string[] = [];
  const removed: Array<{ start: number; end: number }> = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') break;
    if (token === '--settings' && index + 1 < tokens.length) {
      values.push(tokens[index + 1]);
      removed.push({ start: spans[index].start, end: spans[index + 1].end });
      index += 1;
    } else if (token.startsWith('--settings=')) {
      values.push(token.slice('--settings='.length));
      removed.push(spans[index]);
    }
  }

  const sources: ClaudeSettings[] = [];
  for (const value of values) {
    const settings = readSettingsValue(value, input.cwd);
    if (!settings) return undefined;
    sources.push(settings);
  }

  let command = input.command;
  for (const span of [...removed].reverse()) {
    command = `${command.slice(0, span.start).trimEnd()} ${command.slice(span.end).trimStart()}`.trimEnd();
  }
  const insertAt = spans[0].end;
  command = `${command.slice(0, insertAt)} --settings ${fileWord}${command.slice(insertAt)}`;
  return { command, settings: [...sources, input.extra].reduce(mergeClaudeSettings, {}) };
}

/** A `--settings` value (inline JSON or a file) as settings; undefined when unreadable. */
function readSettingsValue(value: string, cwd: string): ClaudeSettings | undefined {
  const trimmed = value.trim();
  let text = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      text = readFileSync(path.resolve(cwd, trimmed), 'utf8');
    } catch {
      return undefined;
    }
  }
  try {
    return decodeOptionalBoundary(JSON.parse(text), boundary.jsonObject);
  } catch {
    return undefined;
  }
}

/** Objects merge key by key and lists join; otherwise the later value wins. */
export function mergeClaudeSettings(base: ClaudeSettings, next: ClaudeSettings): ClaudeSettings {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const current = merged[key];
    const before = asObject(current);
    const after = asObject(value);
    if (Array.isArray(current) && Array.isArray(value)) merged[key] = [...current, ...value];
    else if (before && after) merged[key] = mergeClaudeSettings(before, after);
    else merged[key] = value;
  }
  return merged;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return decodeOptionalBoundary(value, boundary.jsonObject);
}
