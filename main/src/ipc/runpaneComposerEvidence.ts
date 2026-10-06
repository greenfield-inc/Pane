import type { TerminalPanelState } from '../../../shared/types/panels';

export type ComposerEvidenceVerdict = 'staged' | 'cleared' | 'unknown';

const COMPOSER_PROMPT_PATTERN = /^[>›❯▌]/u;
const COMPOSER_AUXILIARY_PATTERN = /^(?:\/\S|\[Pasted Content|(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit)/iu;
const MAX_MARKER_LENGTH = 80;

const PENDING_COMPOSER_PATTERN = /\[Pasted (?:Content|text)[^\]]*\]|(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit/iu;
/** Without a prompt line, only the screen's last few lines can be a composer. */
const COMPOSER_TAIL_LINES = 3;

/**
 * Codex 0.160 reserves a status row between its composer gap and shortcut row.
 * StartupDraft leaves it empty during daemon/trust checks; ChatWidget fills it.
 * Require that exact bottom surface, not model names inside a multiline draft.
 * Custom/hidden footers without these markers remain unverified.
 */
function configuredCodexFooterStart(lines: readonly string[]): number | undefined {
  const last = lines.map(line => line.length > 0).lastIndexOf(true);
  if (last < 2 || !/^(?:← for agents · )?\? for shortcuts\b/iu.test(lines[last]) || lines[last - 2] !== '') return undefined;
  const status = lines[last - 1];
  const configured = /^(?:gpt[-\s]\d[\w.-]*|o\d(?:[-.][\w.-]+)?)(?:\s|$)/iu.test(status)
    || /^\d+% context left\b/iu.test(status);
  return configured ? last - 1 : undefined;
}

export function hasConfiguredCodexScreen(text: string): boolean {
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  const footer = configuredCodexFooterStart(lines);
  return footer !== undefined && lines.slice(0, footer).some(line => /^[›❯]/u.test(line));
}

/**
 * Whether the composer holds a paste marker or Codex's Ctrl+Enter hint. Only
 * the composer counts: the last prompt line and what follows it (or, with no
 * prompt line, the last few lines), so an earlier `[Pasted text #1]` turn in
 * the transcript above does not.
 */
export function looksLikePendingComposer(text: string): boolean {
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  let promptLine = -1;
  for (let index = lines.length - 1; index >= 0 && promptLine < 0; index -= 1) {
    if (COMPOSER_PROMPT_PATTERN.test(lines[index])) promptLine = index;
  }
  const composer = promptLine >= 0
    ? lines.slice(promptLine)
    : lines.filter(line => line.length > 0).slice(-COMPOSER_TAIL_LINES);
  return composer.some(line => PENDING_COMPOSER_PATTERN.test(line));
}

export function isSlashCommandInput(input: string): boolean {
  return /^\/\S/u.test(input.trimStart());
}

export function assessComposerEvidence(args: {
  beforeText: string;
  afterText: string;
  stagedText: string;
  agentType?: TerminalPanelState['agentType'];
}): ComposerEvidenceVerdict {
  const marker = firstNonEmptyLine(args.stagedText)?.slice(0, MAX_MARKER_LENGTH);
  if (!marker) {
    return 'unknown';
  }

  if (args.agentType === 'opencode') {
    const before = openCodeComposer(args.beforeText);
    const after = openCodeComposer(args.afterText);
    // Soft wrapping inserts line breaks inside words; compare prompt content
    // independently of the TUI's current column width.
    if (before === undefined || after === undefined) return 'unknown';
    const pasteMarker = `[Pasted ~${args.stagedText.trim().split(/\r?\n/u).length} lines]`.replace(/\s/gu, '');
    const normalizedBefore = before.replace(/\s/gu, '');
    const content = normalizedBefore.includes(pasteMarker) ? pasteMarker : marker.replace(/\s/gu, '');
    if (!normalizedBefore.includes(content)) return 'unknown';
    if (!after.replace(/\s/gu, '').includes(content)) return 'cleared';
    return before === after ? 'staged' : 'unknown';
  }

  if (!args.afterText.includes(marker)) {
    return 'cleared';
  }

  const beforeComposerLine = lastComposerLine(args.beforeText, marker);
  const afterComposerLine = lastComposerLine(args.afterText, marker);
  if (
    beforeComposerLine !== undefined &&
    afterComposerLine !== undefined &&
    beforeComposerLine === afterComposerLine
  ) {
    return 'staged';
  }

  return 'unknown';
}

/** Scope input to the live footer's textarea, excluding padded agent/model metadata. */
function openCodeComposer(text: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  const footer = lines.map(line => line.includes('ctrl+p commands')).lastIndexOf(true);
  if (footer < 0 || lines.slice(footer + 1).filter(line => line.trim()).length > 2) return undefined;
  let end = footer;
  // Transparent themes render the bottom border entirely as spaces.
  while (end > 0 && !lines[end - 1].trim()) end -= 1;
  if (end > 0 && /^\s*╹▀{3,}/u.test(lines[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /^\s*┃/u.test(lines[start - 1])) start -= 1;
  const rows = lines.slice(start, end).map(line => line.replace(/^\s*┃\s?/u, '').trim());
  const metadataGap = rows.lastIndexOf('');
  if (rows[0] !== '' || metadataGap < 1 || metadataGap === rows.length - 1) return undefined;
  return rows.slice(1, metadataGap).join('\n');
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.length > 0);
}

function lastComposerLine(text: string, marker: string): string | undefined {
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  const composerEnd = configuredCodexFooterStart(lines) ?? lines.length;
  for (let index = composerEnd - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(marker)) {
      continue;
    }

    const followingLines = lines.slice(index + 1, composerEnd).filter(candidate => candidate.length > 0);
    const couldBeTranscript = followingLines.some(candidate => !COMPOSER_AUXILIARY_PATTERN.test(candidate));
    if (couldBeTranscript) {
      return undefined;
    }

    if (COMPOSER_PROMPT_PATTERN.test(line) || (line === marker && followingLines.length === 0)) {
      return line;
    }
  }
  return undefined;
}
