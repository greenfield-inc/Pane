import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { TerminalAgentReport, TerminalAgentReportState, ToolPanel } from '../../../shared/types/panels';

/**
 * Worker reports (`runpane report`): a worker's structured hand-back of its
 * state, PR, head commit, summary, and question. The latest report per panel
 * lives in the panel's custom state (`agentReport`).
 */

export const AGENT_REPORT_STATES = ['ready', 'blocked', 'failed', 'done'] as const satisfies readonly TerminalAgentReportState[];
/** The panel keeps this much summary; the CLIs send one character more so an overflow still reads as truncated. */
export const MAX_AGENT_REPORT_SUMMARY_LENGTH = 16_000;
/** An `agent.report` journal entry carries this much summary, so watch lines stay small. */
export const MAX_JOURNAL_REPORT_SUMMARY_LENGTH = 2_000;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_SUMMARY_PATH_LENGTH = 4_096;
const TRUNCATION_MARKER = '\n[summary truncated]';
const HEAD_PATTERN = /^[0-9a-f]{7,40}$/u;

export interface AgentReportInput {
  state: TerminalAgentReportState;
  pr?: number;
  head?: string;
  summary?: string;
  summaryPath?: string;
  question?: string;
}

const agentReportSchema = boundary.object({
  state: boundary.enumeration(...AGENT_REPORT_STATES),
  pr: boundary.optional(boundary.number),
  head: boundary.optional(boundary.string),
  summary: boundary.optional(boundary.string),
  summaryTruncated: boundary.optional(boundary.literal(true)),
  summaryPath: boundary.optional(boundary.string),
  question: boundary.optional(boundary.string),
  reportedAt: boundary.nonEmptyString,
});

/** Validates a report request and bounds its text; throws a message the CLI prints as is. */
export function normalizeAgentReport(input: AgentReportInput, reportedAt: string): TerminalAgentReport {
  if (!AGENT_REPORT_STATES.includes(input.state)) {
    throw new Error(`state must be one of: ${AGENT_REPORT_STATES.join(', ')}`);
  }
  if (input.pr !== undefined && (!Number.isInteger(input.pr) || input.pr <= 0)) {
    throw new Error('pr must be a positive integer');
  }
  const head = input.head?.trim().toLowerCase();
  if (head !== undefined && !HEAD_PATTERN.test(head)) {
    throw new Error('head must be a commit SHA of 7 to 40 hex characters');
  }
  const question = input.question?.trim();
  if (input.state === 'blocked' && !question) {
    throw new Error('A blocked report needs a question: pass --question "<what you need answered>"');
  }
  const summaryPath = input.summaryPath?.trim();
  if (summaryPath !== undefined && summaryPath.length > MAX_SUMMARY_PATH_LENGTH) {
    throw new Error('summaryPath is too long');
  }

  const report: TerminalAgentReport = { state: input.state, reportedAt };
  if (input.pr !== undefined) report.pr = input.pr;
  if (head) report.head = head;
  const summary = input.summary?.trim();
  if (summary) {
    const bounded = boundSummary(summary, MAX_AGENT_REPORT_SUMMARY_LENGTH);
    report.summary = bounded.text;
    if (bounded.truncated) report.summaryTruncated = true;
  }
  if (summaryPath) report.summaryPath = summaryPath;
  if (question) report.question = question.length > MAX_QUESTION_LENGTH ? `${question.slice(0, MAX_QUESTION_LENGTH - 1)}…` : question;
  return report;
}

/** The report as an `agent.report` journal entry carries it: the same fields, with the summary cut shorter. */
export function journalAgentReport(report: TerminalAgentReport): TerminalAgentReport {
  if (!report.summary || report.summary.length <= MAX_JOURNAL_REPORT_SUMMARY_LENGTH) return { ...report };
  return { ...report, summary: boundSummary(report.summary, MAX_JOURNAL_REPORT_SUMMARY_LENGTH).text, summaryTruncated: true };
}

const panelReportSchema = boundary.object({ agentReport: agentReportSchema });

/** The panel's latest report, or undefined when it has none (or an unreadable one). */
export function readPanelAgentReport(panel: Pick<ToolPanel, 'state'> | undefined): TerminalAgentReport | undefined {
  return decodeOptionalBoundary(panel?.state?.customState, panelReportSchema)?.agentReport;
}

interface BoundedSummary {
  text: string;
  truncated: boolean;
}

function boundSummary(text: string, limit: number): BoundedSummary {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`, truncated: true };
}
