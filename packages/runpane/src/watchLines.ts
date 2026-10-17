export type WatchFormat = 'lines' | 'json';

export function effectiveWatchHeartbeatMs(seconds: number): number {
  const configuredMs = seconds * 1_000;
  return configuredMs > 0 ? Math.min(configuredMs, 120_000) : 0;
}

interface WatchEntry {
  gen: number;
  at: string;
  kind: string;
  paneId: string;
  paneName: string;
  panelId?: string;
  heldInput?: string;
  heldInputPresent?: boolean;
  exitCode?: number;
  baseline?: true;
  changedWhileAway?: boolean;
  sessionId?: string;
  pr?: { number: number };
  checks?: string;
  reason?: string | null;
  failingChecks?: string[];
  idleMs?: number;
  idleCount?: number;
  report?: WatchReport;
  nudged?: boolean;
}

/** The fields of a worker report a REPORT line shows. */
interface WatchReport {
  state: string;
  pr?: number;
  head?: string;
  question?: string;
}

const MAX_LINE_QUESTION_LENGTH = 200;

export interface WatchResult {
  epoch: string;
  generation: number;
  entries: WatchEntry[];
  dropped?: number;
  reset?: { reason: string };
}

function sanitizeName(value: string): string {
  const printable = [...value]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 ? ' ' : character;
    })
    .join('');
  return printable.replace(/\s+/gu, ' ').trim() || '<unnamed>';
}

function formatEntryLine(entry: WatchEntry): string | undefined {
  if (entry.baseline && !entry.changedWhileAway) return undefined;
  const name = sanitizeName(entry.paneName);
  const pane = `pane ${sanitizeName(entry.paneId)}`;
  const panel = entry.panelId ? ` panel ${sanitizeName(entry.panelId)}` : '';
  if (entry.changedWhileAway && entry.kind !== 'panel.stopped') return `CHANGED ${name} ${pane}${panel}`;
  switch (entry.kind) {
    case 'agent.ready': return `READY ${name} ${pane}${panel}`;
    case 'agent.busy': return `BUSY ${name} ${pane}${panel}`;
    case 'agent.blocked': return `BLOCKED ${name} ${pane}${panel}`;
    case 'agent.unknown': return `UNKNOWN ${name} ${pane}${panel}`;
    case 'agent.idle': {
      const minutes = Math.max(0, Math.floor((entry.idleMs ?? 0) / 60_000));
      return `IDLE ${name} ${minutes}m ${pane}${panel}`;
    }
    case 'pane.created': return `NEW ${name} ${pane}`;
    case 'pane.gone': return `GONE ${name} ${pane}`;
    case 'pane.associated': return `JOINED ${name} ${pane} session ${sanitizeName(entry.sessionId ?? '')}`;
    case 'pane.detached': return `LEFT ${name} ${pane} session ${sanitizeName(entry.sessionId ?? '')}`;
    case 'panel.stopped': return `STOPPED ${name} ${pane}${panel}`;
    case 'panel.resumed': return `RESUMED ${name} ${pane}${panel} ${sanitizeName(entry.reason ?? 'unknown')}${entry.nudged ? '' : ' NOT NUDGED'}`;
    case 'panel.exited': return `EXIT ${name} ${pane}${panel} code ${entry.exitCode ?? 'unknown'}`;
    case 'pr.conflicted': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} CONFLICTED`;
    case 'pr.checks': return formatChecksLine(`PR ${name} ${pane} #${entry.pr?.number ?? '?'}`, entry);
    case 'pr.merged': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} MERGED`;
    case 'pr.closed': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} CLOSED${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'pr.head': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} HEAD CHANGED${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'pr.base_changed': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} BASE CHANGED${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'pr.base_deleted': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} BASE DELETED${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'pr.review': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} REVIEW${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'pr.comment': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} COMMENT${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'pr.stopped': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} WATCH STOPPED${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'github.unavailable': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} GITHUB UNAVAILABLE${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'github.recovered': return `PR ${name} ${pane} #${entry.pr?.number ?? '?'} GITHUB RECOVERED${entry.reason ? ': ' + sanitizeName(entry.reason) : ''}`;
    case 'agent.report': return `REPORT ${name} ${pane}${panel} ${entry.report ? describeReport(entry.report) : 'unknown'}`;
    case 'agent.report.missing': return `MISSING REPORT ${name} ${pane}${panel} ${sanitizeName(entry.reason ?? 'ready')}`;
    default: return `UNKNOWN ${name} ${pane}${panel}`;
  }
}

/** `CHECKS FAILED lint,test`: failing names are joined by commas, so their own spaces and commas become `_`. */
function formatChecksLine(prefix: string, entry: WatchEntry): string {
  if (entry.checks !== 'failed') return `${prefix} CHECKS PASSED`;
  const names = (entry.failingChecks ?? []).map(check => sanitizeName(check).replace(/[ ,]/gu, '_'));
  return `${prefix} CHECKS FAILED${names.length > 0 ? ` ${names.join(',')}` : ''}`;
}

/**
 * `ready pr#747 fc5dce9`, or `blocked pr#747: <question>`: the state, PR, and short head of a
 * report, then a blocked worker's question on one line, cut to 200 characters.
 */
export function describeReport(report: WatchReport): string {
  const parts = [sanitizeName(report.state)];
  if (report.pr !== undefined) parts.push(`pr#${report.pr}`);
  if (report.head) parts.push(sanitizeName(report.head).slice(0, 7));
  const question = report.question ? sanitizeName(report.question) : '';
  if (!question) return parts.join(' ');
  const shown = question.length > MAX_LINE_QUESTION_LENGTH ? `${question.slice(0, MAX_LINE_QUESTION_LENGTH - 1)}…` : question;
  return `${parts.join(' ')}: ${shown}`;
}

export function formatWaitResult(result: WatchResult, format: WatchFormat): string[] {
  if (format === 'json') {
    const lines: string[] = [];
    if (result.reset) {
      lines.push(JSON.stringify({ kind: '_reset', reason: result.reset.reason, epoch: result.epoch, generation: result.generation }));
    }
    if (result.dropped !== undefined) lines.push(JSON.stringify({ kind: '_dropped', count: result.dropped, epoch: result.epoch, generation: result.generation }));
    lines.push(...result.entries.map(entry => JSON.stringify({ ...entry, epoch: result.epoch })));
    return lines;
  }

  const lines: string[] = [];
  if (result.reset) lines.push(`RESET ${sanitizeName(result.reset.reason)} epoch ${sanitizeName(result.epoch)}`);
  if (result.dropped !== undefined) lines.push(`DROPPED ${result.dropped}`);
  for (const entry of result.entries) {
    const line = formatEntryLine(entry);
    if (line) lines.push(line);
    if ((entry.kind === 'agent.ready' || entry.kind === 'agent.idle') && (entry.heldInputPresent || entry.heldInput)) {
      lines.push(`STUCK ${sanitizeName(entry.paneName)} pane ${sanitizeName(entry.paneId)}${entry.panelId ? ` panel ${sanitizeName(entry.panelId)}` : ''} held-input-present`);
    }
  }
  return lines;
}

export function formatNonEntry(
  kind: '_ok' | '_heartbeat' | '_error' | '_reconnected' | '_timeout' | '_expired',
  fields: Record<string, string | number | undefined>,
  format: WatchFormat,
): string {
  if (format === 'json') return JSON.stringify({ kind, ...fields });
  if (kind === '_ok') return `WATCH OK gen ${fields.generation} epoch ${sanitizeName(String(fields.epoch))}`;
  if (kind === '_heartbeat') return `HEARTBEAT gen ${fields.generation} at ${fields.at}`;
  if (kind === '_reconnected') return `WATCH RECONNECTED gen ${fields.generation}`;
  if (kind === '_timeout') return `WATCH TIMEOUT after ${fields.timeoutMs}ms`;
  if (kind === '_expired') return `WATCH EXPIRED after ${fields.expireAfterMs}ms quiet`;
  return `WATCH ERROR ${sanitizeName(String(fields.code))}: ${sanitizeName(String(fields.message))}`;
}
