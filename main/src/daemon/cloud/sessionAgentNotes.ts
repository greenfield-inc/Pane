import fs from 'fs';
import os from 'os';
import path from 'path';
import { boundary, BoundaryDecodeError, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneCommandError } from '../../core/commandError';
import type { PaneCommandRegistry, PaneCommandValue } from '../commandRegistry';
import { CLOUD_SERVE_RECORD } from './cloudSessionMarker';

/**
 * Notes for agents in a Runpane Cloud Session, kept by the Session's daemon in the user-level instruction
 * files Claude Code and Codex read (beside the CLI's runpane-cloud-github and runpane-cloud-secrets blocks).
 * The daemon writes them, not the CLI, so a Session gets the notes that match the Pane it runs, including
 * after an upgrade, without a repair. Two blocks: how to publish ports, and the user's own guardrails
 * (their `agentNotes.guardrails` setting, delivered by `runpane cloud notes`; Pane ships none).
 */
const NOTES_START = '<!-- runpane-cloud-ports:start -->';
const NOTES_END = '<!-- runpane-cloud-ports:end -->';
const GUARDRAILS_START = '<!-- runpane-cloud-guardrails:start -->';
const GUARDRAILS_END = '<!-- runpane-cloud-guardrails:end -->';
/**
 * The user's guardrails for this Session, as `runpane cloud notes` last delivered them (the list itself
 * lives in the user's `agentNotes.guardrails` setting on their machine). Kept so every boot and wake
 * renders them again without the laptop.
 */
const AGENT_NOTES_CONFIG = path.join('.runpane-cloud', 'agent-notes.json');
const MAX_GUARDRAILS = 20;
const MAX_GUARDRAIL_LENGTH = 500;

export function portsAgentNotes(): string {
  return `${NOTES_START}
## Showing a web service from this runpane cloud Session

This Session is a cloud machine. The person you work for is not on it, so \`localhost\` links don't open for them.

- **Publish anything you serve** (dev server, preview, Storybook, docs): start it on 127.0.0.1 or 0.0.0.0, then run \`runpane port open <port> --name <name>\`. It prints a tailnet-only \`https://<host>.<tailnet>.ts.net:<port>/\` URL that opens on their laptop and phone.
- **Paste that https URL** in your reply, never a \`http://localhost:<port>\` address.
- **See what's published:** \`runpane port list\` (\`--verify\` requests each URL). **Stop publishing:** \`runpane port close <name>\`.
- If the page says the host is not allowed (Vite "Blocked request", webpack "Invalid Host header"), allow \`.ts.net\` in the dev server's allowed hosts.
- If the URL starts with \`http://\` (the Session has no TLS certificate yet), say so: sign-ins that use Secure cookies fail until it moves to https by itself.
- Ports in the repository's \`.runpane/ports.json\` are published automatically. Don't publish debuggers or database consoles unless asked.
${NOTES_END}`;
}

/** `text` with the marked block replaced where it is (or appended after a blank line); other text is kept. */
export function upsertMarkedBlock(text: string, block: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  if (to !== -1) return `${text.slice(0, from)}${block}${text.slice(to + end.length)}`;
  const rest = text.replace(/\n+$/u, '');
  return `${rest.trim() ? `${rest}\n\n` : ''}${block}\n`;
}

/** The user's guardrails as one marked block; null for an empty list (the block is then removed). */
export function guardrailsAgentNotes(guardrails: readonly string[]): string | null {
  if (guardrails.length === 0) return null;
  return `${GUARDRAILS_START}
## Guardrails from the person you work for

They set these for every runpane cloud Session. They apply on top of any other instructions; when one applies, stop and ask them before going on.

${guardrails.map(line => `- ${line}`).join('\n')}
${GUARDRAILS_END}`;
}

/** `text` without the marked block (and the blank line before it); other text is kept. */
export function removeMarkedBlock(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  if (to === -1) return text;
  const head = text.slice(0, from).replace(/\n+$/u, '');
  const tail = text.slice(to + end.length).replace(/^\n+/u, '');
  if (!head) return tail;
  return tail ? `${head}\n\n${tail}` : `${head}\n`;
}

/** Trimmed, one line each, without repeats; throws on an empty, multi-line or overlong entry. */
export function normalizeGuardrails(guardrails: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of guardrails) {
    const line = raw.trim();
    if (!line) throw new Error('A guardrail cannot be empty.');
    if (/[\r\n]/u.test(line)) throw new Error('A guardrail must be a single line.');
    // A marker inside a line would make the next write match the wrong block end.
    if (line.includes('<!--') || line.includes('-->')) throw new Error('A guardrail cannot contain HTML comment markers (<!-- or -->).');
    if (line.length > MAX_GUARDRAIL_LENGTH) throw new Error(`A guardrail can be at most ${MAX_GUARDRAIL_LENGTH} characters.`);
    if (seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  if (result.length > MAX_GUARDRAILS) throw new Error(`At most ${MAX_GUARDRAILS} guardrails.`);
  return result;
}

const agentNotesConfigSchema = boundary.object({ guardrails: boundary.array(boundary.string) });

/** The delivered guardrails; none when the file is missing or unreadable (never fatal at boot). */
export function readGuardrails(home: string = os.homedir()): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(home, AGENT_NOTES_CONFIG), 'utf8'));
    return normalizeGuardrails(decodeBoundary(parsed, agentNotesConfigSchema).guardrails);
  } catch {
    return [];
  }
}

function saveGuardrails(home: string, guardrails: readonly string[], now: Date): void {
  const file = path.join(home, AGENT_NOTES_CONFIG);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, guardrails, updatedAt: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

interface SessionAgentNotesOptions {
  home?: string;
  serveRecordPath?: string;
}

/**
 * Writes the notes on a Runpane Cloud Session (the ports block, and the user's guardrails when there
 * are any); returns the files it changed (none off a Session). Runs at every daemon start, or when the
 * bootstrap writes the Session marker on a new Session.
 */
export function writeSessionAgentNotes(options: SessionAgentNotesOptions = {}): string[] {
  if (!fs.existsSync(options.serveRecordPath ?? CLOUD_SERVE_RECORD)) return [];
  const home = options.home ?? os.homedir();
  const block = portsAgentNotes();
  const guardrails = guardrailsAgentNotes(readGuardrails(home));
  const changed: string[] = [];
  for (const file of [path.join(home, '.claude', 'CLAUDE.md'), path.join(home, '.codex', 'AGENTS.md')]) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const withPorts = upsertMarkedBlock(before, block, NOTES_START, NOTES_END);
    const after = guardrails
      ? upsertMarkedBlock(withPorts, guardrails, GUARDRAILS_START, GUARDRAILS_END)
      : removeMarkedBlock(withPorts, GUARDRAILS_START, GUARDRAILS_END);
    if (after === before) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
    changed.push(file);
  }
  return changed;
}

const agentNotesRequestSchema = boundary.object({ guardrails: boundary.optional(boundary.array(boundary.string)) });

/**
 * `runpane:cloud:agent-notes`: without arguments, the guardrails this Session has; with `guardrails`,
 * stores them (replacing the list) and rewrites the notes now. `runpane cloud notes` on the user's
 * machine calls it with their `agentNotes.guardrails` setting. Not on the coordinator's allow-list.
 */
export function registerAgentNotesHandler(
  commandRegistry: PaneCommandRegistry,
  options: SessionAgentNotesOptions & { now?: () => Date } = {},
): void {
  commandRegistry.register('runpane:cloud:agent-notes', async (request: PaneCommandValue = {}) => {
    let wanted: string[] | undefined;
    try {
      const decoded = decodeBoundary(request ?? {}, agentNotesRequestSchema);
      wanted = decoded.guardrails === undefined ? undefined : normalizeGuardrails(decoded.guardrails);
    } catch (error) {
      const message = error instanceof BoundaryDecodeError ? error.message : error instanceof Error ? error.message : String(error);
      throw new PaneCommandError(`Invalid agent notes request: ${message}`, 'ERR_AGENT_NOTES_INVALID');
    }
    if (!fs.existsSync(options.serveRecordPath ?? CLOUD_SERVE_RECORD)) {
      throw new PaneCommandError('Agent notes are only for Runpane Cloud Sessions (this daemon is not in one).', 'ERR_AGENT_NOTES_UNAVAILABLE');
    }
    const home = options.home ?? os.homedir();
    if (wanted !== undefined) saveGuardrails(home, wanted, (options.now ?? (() => new Date()))());
    const files = writeSessionAgentNotes(options);
    return { ok: true, guardrails: readGuardrails(home), changedFiles: files };
  });
}
