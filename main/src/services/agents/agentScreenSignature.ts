import { CODEX_LOADING_HEADER } from '../agentStatus/manifests';
import type { CliAgentType } from './agentIdentity';

/** What a terminal screen shows of an agent's input composer. */
export interface AgentComposerState {
  isPresent: boolean;
  hasUndeliveredText: boolean;
  /** Placeholder or suggestion text drawn in the composer (dim or placeholder grey), which is not input. */
  ghostText?: string;
}

/**
 * The same viewport split by cell kind (see TerminalStateEmulator): typed
 * cells only, and ghost cells only, row for row. Without them the screen
 * text is read as typed.
 */
export interface ComposerScreenLayers {
  typedText?: string;
  ghostText?: string;
}

const NO_COMPOSER: AgentComposerState = { isPresent: false, hasUndeliveredText: false };
const CODEX_HEADER = /\bOpenAI Codex\b/u;

function screenLines(text: string): string[] {
  return text.split(/\r?\n/u).map(line => line.trim());
}

function isRule(line: string | undefined): boolean {
  return line !== undefined && /^─{3,}$/u.test(line);
}

interface ClaudeComposerBox {
  composer: AgentComposerState;
  closed: boolean;
  /** Rows of the prompt line and any held lines below it. */
  rows: { start: number; end: number };
}

// Claude draws its composer as a `❯` line boxed between two horizontal rules;
// held input is anything between the prompt marker and the closing rule.
function findClaudeComposerBox(lines: readonly string[]): ClaudeComposerBox | undefined {
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const match = lines[index].match(/^❯(?:\s+(.*))?$/u);
    if (!match || !isRule(lines[index - 1])) continue;

    const closingRule = lines.findIndex((line, lineIndex) => lineIndex > index && isRule(line));
    const end = closingRule < 0 ? lines.length : closingRule;
    const held = [match[1] ?? '', ...lines.slice(index + 1, end)];
    return {
      composer: { isPresent: true, hasUndeliveredText: held.some(line => line.length > 0) },
      closed: closingRule >= 0,
      rows: { start: index, end },
    };
  }
  return undefined;
}

/** The ghost text on the given rows, one line per row with any. */
function ghostTextOnRows(ghostText: string | undefined, start: number, end: number): string | undefined {
  if (!ghostText) return undefined;
  const text = screenLines(ghostText).slice(start, end).filter(Boolean).join('\n');
  return text || undefined;
}

function withGhostText(composer: AgentComposerState, ghostText: string | undefined): AgentComposerState {
  return ghostText ? { ...composer, ghostText } : composer;
}

function detectClaudeComposer(text: string, layers: ComposerScreenLayers): AgentComposerState {
  const box = findClaudeComposerBox(screenLines(layers.typedText ?? text));
  if (!box) return NO_COMPOSER;
  return withGhostText(box.composer, ghostTextOnRows(layers.ghostText, box.rows.start, box.rows.end));
}

function detectCodexComposer(text: string, layers: ComposerScreenLayers): AgentComposerState {
  if (CODEX_LOADING_HEADER.test(text)) return NO_COMPOSER;

  const lines = screenLines(layers.typedText ?? text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^[›❯]\s*(.*)$/u);
    if (!match) continue;

    const content = match[1].trim();
    const isPlaceholder = /^ask codex to do anything[.!]?$/iu.test(content);
    return withGhostText({
      isPresent: true,
      hasUndeliveredText: content.length > 0 && !isPlaceholder,
    }, ghostTextOnRows(layers.ghostText, index, index + 1));
  }

  const hasPastedContent = /\[Pasted Content[^\]]*\]/iu.test(text);
  return {
    isPresent: hasPastedContent,
    hasUndeliveredText: hasPastedContent,
  };
}

/** The composer of a known agent; agents without composer detection report none. */
export function detectAgentComposer(
  text: string,
  agentType: CliAgentType | undefined,
  layers: ComposerScreenLayers = {},
): AgentComposerState {
  if (agentType === 'claude') return detectClaudeComposer(text, layers);
  if (agentType === 'codex') return detectCodexComposer(text, layers);
  return NO_COMPOSER;
}

// Claude 2.1 lists queued messages above its composer with a `ctrl+x ctrl+s to
// send now` hint and puts `Press up to edit queued messages` in the composer.
// Codex 0.15x lists them under `Messages to be submitted after next tool call`
// (older builds: a `queued` hint), one `↳ <message>` line each.
const CLAUDE_QUEUED_HINT = /press up to edit queued messages|ctrl\+x ctrl\+s to send now/iu;
const CODEX_QUEUED_HINT = /messages to be submitted after next tool call|\bqueued (?:message|follow-up)s?\b/iu;

function queuedHint(agentType: CliAgentType | undefined): RegExp | undefined {
  if (agentType === 'claude') return CLAUDE_QUEUED_HINT;
  if (agentType === 'codex') return CODEX_QUEUED_HINT;
  return undefined;
}

/**
 * Whether the screen shows `message` waiting in the agent's queue: the
 * agent's queued-message hint, with the message's first line (or its start)
 * shown above the composer.
 */
export function screenShowsQueuedMessage(text: string, agentType: CliAgentType | undefined, message: string): boolean {
  const hint = queuedHint(agentType);
  if (!hint?.test(text)) return false;

  const firstLine = message.split('\n').map(line => line.trim()).find(Boolean);
  if (!firstLine) return false;
  const marker = firstLine.slice(0, 60);
  const lines = screenLines(text);
  const composerRow = agentType === 'claude'
    ? findClaudeComposerBox(lines)?.rows.start ?? lines.length
    : lines.length;
  return lines.slice(0, composerRow).some(line => /^(?:❯|↳)\s/u.test(line) && line.includes(marker));
}

/**
 * Identify an agent from one screen: Claude's closed rule/`❯`/rule composer
 * box, or Codex's `OpenAI Codex` header with its `›` prompt. Callers that
 * persist the result require it on consecutive polls, since one frame can
 * be anything.
 */
export function detectAgentFromScreen(text: string | undefined): CliAgentType | undefined {
  if (!text) return undefined;
  const lines = screenLines(text);
  if (findClaudeComposerBox(lines)?.closed) return 'claude';
  if (CODEX_HEADER.test(text) && lines.some(line => /^›(?:\s|$)/u.test(line))) return 'codex';
  return undefined;
}
