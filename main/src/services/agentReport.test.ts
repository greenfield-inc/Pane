import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_REPORT_SUMMARY_LENGTH,
  MAX_AGENT_REPORT_DATA_DEPTH,
  MAX_JOURNAL_REPORT_SUMMARY_LENGTH,
  agentReportData,
  journalAgentReport,
  normalizeAgentReport,
  readPanelAgentReport,
} from './agentReport';

const AT = '2026-09-27T18:00:00.000Z';

describe('normalizeAgentReport', () => {
  it('keeps the fields a worker gave, with the head lowercased', () => {
    expect(normalizeAgentReport({
      state: 'ready', pr: 747, head: 'FC5DCE9', summary: '  Tests pass.\n', summaryPath: '/tmp/report.md',
    }, AT)).toEqual({
      state: 'ready', pr: 747, head: 'fc5dce9', summary: 'Tests pass.', summaryPath: '/tmp/report.md', reportedAt: AT,
    });
  });

  it('rejects a blocked report without a question, a bad PR, and a bad head', () => {
    expect(() => normalizeAgentReport({ state: 'blocked', question: '  ' }, AT)).toThrow(/needs a question/);
    expect(() => normalizeAgentReport({ state: 'ready', pr: 0 }, AT)).toThrow(/positive integer/);
    expect(() => normalizeAgentReport({ state: 'ready', pr: 1.5 }, AT)).toThrow(/positive integer/);
    expect(() => normalizeAgentReport({ state: 'ready', head: 'abc123' }, AT)).toThrow(/7 to 40 hex/);
    expect(() => normalizeAgentReport({ state: 'ready', head: 'g'.repeat(7) }, AT)).toThrow(/7 to 40 hex/);
    expect(normalizeAgentReport({ state: 'blocked', question: 'Drop the column?' }, AT).question).toBe('Drop the column?');
  });

  it('cuts a summary past 16,000 characters with a marker, and the journal copy to 2,000', () => {
    const report = normalizeAgentReport({ state: 'done', summary: 'x'.repeat(MAX_AGENT_REPORT_SUMMARY_LENGTH + 1) }, AT);
    expect(report.summary).toHaveLength(MAX_AGENT_REPORT_SUMMARY_LENGTH);
    expect(report.summary?.endsWith('\n[summary truncated]')).toBe(true);
    expect(report.summaryTruncated).toBe(true);

    const journal = journalAgentReport(report);
    expect(journal.summary).toHaveLength(MAX_JOURNAL_REPORT_SUMMARY_LENGTH);
    expect(journal.summaryTruncated).toBe(true);
    const short = normalizeAgentReport({ state: 'done', summary: 'Short.' }, AT);
    expect(journalAgentReport(short)).toEqual(short);
    expect(short.summaryTruncated).toBeUndefined();
  });
});

describe('readPanelAgentReport', () => {
  it('reads a stored report and ignores a missing or malformed one', () => {
    const report = { state: 'failed', summary: 'CI is red.', reportedAt: AT };
    expect(readPanelAgentReport({ state: { isActive: true, customState: { agentReport: report } } })).toEqual(report);
    expect(readPanelAgentReport({ state: { isActive: true, customState: {} } })).toBeUndefined();
    expect(readPanelAgentReport({ state: { isActive: true, customState: { agentReport: { state: 'maybe' } } } })).toBeUndefined();
    expect(readPanelAgentReport(undefined)).toBeUndefined();
  });
});

describe('agentReportData', () => {
  const report = (summary: string) => normalizeAgentReport({ state: 'ready', summary }, AT);

  it('returns a JSON object summary as given, and nothing for text, arrays, scalars, invalid or truncated JSON', () => {
    expect(agentReportData(report('{"state":"running","checks":{"pass":["S-1"]}}'))).toEqual({ state: 'running', checks: { pass: ['S-1'] } });
    for (const summary of ['Tests pass.', '["a"]', '42', 'null', '{"a":']) expect(agentReportData(report(summary))).toBeUndefined();
    expect(agentReportData(report(`{"a":"${'x'.repeat(MAX_AGENT_REPORT_SUMMARY_LENGTH)}"}`))).toBeUndefined();
  });

  it('F-1: has no data for an accepted summary nested deeper than the limit, and never throws', () => {
    const deep = report(`{"x":${'['.repeat(2000)}0${']'.repeat(2000)}}`);
    expect(deep.summaryTruncated).toBeUndefined();
    expect(() => agentReportData(deep)).not.toThrow();
    expect(agentReportData(deep)).toBeUndefined();
    const atLimit = `${'{"a":'.repeat(MAX_AGENT_REPORT_DATA_DEPTH)}0${'}'.repeat(MAX_AGENT_REPORT_DATA_DEPTH)}`;
    expect(JSON.stringify(agentReportData(report(atLimit)))).toBe(atLimit);
    const pastLimit = `{"b":${atLimit}}`;
    expect(agentReportData(report(pastLimit))).toBeUndefined();
  });

  it('F-2: keeps top-level and nested __proto__ keys in data', () => {
    const summary = '{"__proto__":{"state":"changed","__proto__":{"deep":true}},"ok":true}';
    const data = agentReportData(report(summary));
    expect(data && Object.hasOwn(data, '__proto__')).toBe(true);
    expect(JSON.stringify(data)).toBe(summary);
  });
});
