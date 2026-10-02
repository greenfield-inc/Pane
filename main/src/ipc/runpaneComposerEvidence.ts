export type ComposerEvidenceVerdict = 'staged' | 'cleared' | 'unknown';

const COMPOSER_PROMPT_PATTERN = /^[>›❯▌]/u;
const COMPOSER_AUXILIARY_PATTERN = /^(?:\/\S|\[Pasted Content|(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit)/iu;
const MAX_MARKER_LENGTH = 80;

const PENDING_COMPOSER_PATTERN = /\[Pasted (?:Content|text)[^\]]*\]|(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit/iu;
/** Without a prompt line, only the screen's last few lines can be a composer. */
const COMPOSER_TAIL_LINES = 3;

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
}): ComposerEvidenceVerdict {
  const marker = firstNonEmptyLine(args.stagedText)?.slice(0, MAX_MARKER_LENGTH);
  if (!marker) {
    return 'unknown';
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

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.length > 0);
}

function lastComposerLine(text: string, marker: string): string | undefined {
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(marker)) {
      continue;
    }

    const followingLines = lines.slice(index + 1).filter(candidate => candidate.length > 0);
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
