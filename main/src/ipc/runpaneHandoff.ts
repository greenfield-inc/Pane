import type { RunpaneAgentId, RunpanePaneReceiveNote } from '../../../shared/types/runpaneOrchestration';

/**
 * Pure helpers for `runpane panes handoff` / `runpane panes receive`.
 *
 * HANDOFF.md is the continuity between runtimes: the source writes it at the
 * worktree root and pushes it; the receiving agent reads it first. Everything
 * here is deterministic and free of daemon/service access so it can be unit
 * tested without git or a Pane database.
 */

export const HANDOFF_NOTE_FILENAME = 'HANDOFF.md';
export const DEFAULT_HANDOFF_REPORT_LINES = 80;

export interface HandoffNote extends RunpanePaneReceiveNote {
  /** Sanitized terminal output; may be empty. */
  report: string;
}

export type HandoffTarget =
  | { kind: 'local' }
  | { kind: 'remote'; label: string };

const FRONT_MATTER_DELIMITER = '---';
const REPORT_HEADING_PREFIX = '## Last agent report';
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/u;

export function parseHandoffTarget(value: string): HandoffTarget {
  const trimmed = value.trim();
  if (trimmed === 'local') {
    return { kind: 'local' };
  }
  const match = /^remote:(.+)$/u.exec(trimmed);
  if (match && match[1].trim()) {
    return { kind: 'remote', label: match[1].trim() };
  }
  throw new Error('--to must be "local" or "remote:<profile label>".');
}

/**
 * Conservative allowlist on top of `git check-ref-format --branch`: the daemon
 * interpolates branch names into shell commands in worktreeManager, so refuse
 * anything that is not plainly a branch name.
 */
export function isSafeBranchName(value: string): boolean {
  if (!value || value.length > 255) return false;
  if (!SAFE_BRANCH_PATTERN.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('..') || value.includes('//') || value.endsWith('.lock')) return false;
  return true;
}

/** Directory name for a received branch: `feat/x` → `feat-x`. */
export function worktreeDirectoryForBranch(branch: string): string {
  return branch.replace(/[\\/]+/gu, '-');
}

export function renderHandoffNote(note: HandoffNote): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(note.report) + 1));
  const report = note.report.trim().length > 0 ? note.report.replace(/\r\n/gu, '\n').trimEnd() : 'no agent panel output captured';
  const lines = [
    FRONT_MATTER_DELIMITER,
    `pane: ${escapeFrontMatterValue(note.pane)}`,
    `branch: ${note.branch}`,
    `head: ${note.head}`,
    `agent: ${note.agent}`,
    `target: ${note.target}`,
    `pr: ${note.pr ?? 'none'}`,
    `handed_off_at: ${note.handedOffAt}`,
    'source: runpane panes handoff',
    FRONT_MATTER_DELIMITER,
    `# Handoff: ${note.pane}`,
    '',
    `Continue from here. Branch ${note.branch} at ${note.head}.`,
    '',
    `${REPORT_HEADING_PREFIX} (sanitized CLI panel output)`,
    `${fence}text`,
    report,
    fence,
    '',
  ];
  return lines.join('\n');
}

/**
 * Reads the front matter written by `renderHandoffNote`. Tolerates CRLF. Throws
 * when a required key is missing so receive can refuse with a clear message.
 */
export function parseHandoffNote(markdown: string): RunpanePaneReceiveNote {
  const lines = markdown.replace(/\r\n/gu, '\n').split('\n');
  if (lines[0]?.trim() !== FRONT_MATTER_DELIMITER) {
    throw new Error('HANDOFF.md does not start with a front matter block');
  }
  const fields = new Map<string, string>();
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === FRONT_MATTER_DELIMITER) break;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (index >= lines.length) {
    throw new Error('HANDOFF.md front matter is not terminated');
  }

  const required = (key: string): string => {
    const value = fields.get(key);
    if (!value) throw new Error(`HANDOFF.md is missing "${key}"`);
    return value;
  };
  const agentValue = fields.get('agent') ?? 'unknown';
  const pr = fields.get('pr');
  return {
    pane: unescapeFrontMatterValue(required('pane')),
    branch: required('branch'),
    head: required('head'),
    agent: isAgentId(agentValue) ? agentValue : 'unknown',
    target: fields.get('target') ?? 'unknown',
    handedOffAt: required('handed_off_at'),
    pr: pr && pr !== 'none' ? pr : undefined,
  };
}

/**
 * One line, no backticks or shell metacharacters: for claude/cursor/codex the
 * create path passes initial input as a launch argument.
 */
export function receiveInstruction(note: Pick<RunpanePaneReceiveNote, 'branch' | 'head'>): string {
  return [
    `Read ${HANDOFF_NOTE_FILENAME} at the root of this worktree first.`,
    `Confirm you are on branch ${note.branch} and that git rev-parse HEAD equals ${note.head} or descends from it, and report both in your first message.`,
    'Then continue the work described in the note.',
    `Delete ${HANDOFF_NOTE_FILENAME} before opening a pull request.`,
    'Do not push until asked.',
  ].join(' ');
}

export function receiveCommandFor(args: {
  repoName: string;
  branch: string;
  agent: RunpaneAgentId | 'unknown';
}): string {
  const agent = args.agent === 'unknown' ? '<codex|claude|cursor>' : args.agent;
  return `runpane panes receive --repo ${quoteArg(args.repoName)} --branch ${quoteArg(args.branch)} --agent ${agent} --yes --json`;
}

export function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/gu)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function escapeFrontMatterValue(value: string): string {
  return value.replace(/\r?\n/gu, ' ').trim();
}

function unescapeFrontMatterValue(value: string): string {
  return value;
}

function isAgentId(value: string): value is RunpaneAgentId {
  return value === 'codex' || value === 'claude' || value === 'cursor';
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9._/:-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}
