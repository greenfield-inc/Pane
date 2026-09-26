import { describe, expect, it } from 'vitest';
import {
  isSafeBranchName,
  longestBacktickRun,
  parseHandoffNote,
  parseHandoffTarget,
  receiveCommandFor,
  receiveInstruction,
  renderHandoffNote,
  worktreeDirectoryForBranch,
} from './runpaneHandoff';

const baseNote = {
  pane: 'issue 252: handoff',
  branch: 'feat/panes-handoff',
  head: '0123456789abcdef0123456789abcdef01234567',
  agent: 'codex' as const,
  target: 'remote:VM',
  pr: 'https://github.com/example/repo/pull/7',
  handedOffAt: '2026-09-11T10:00:00.000Z',
  report: 'Implemented the parser.\nNext: wire the CLI.',
};

describe('runpaneHandoff helpers', () => {
  it('round-trips the front matter through render and parse', () => {
    const parsed = parseHandoffNote(renderHandoffNote(baseNote));
    expect(parsed).toEqual({
      pane: baseNote.pane,
      branch: baseNote.branch,
      head: baseNote.head,
      agent: 'codex',
      target: 'remote:VM',
      handedOffAt: baseNote.handedOffAt,
      pr: baseNote.pr,
    });
  });

  it('keeps a report containing backtick fences inside a longer fence', () => {
    const report = 'before\n```ts\nconst x = 1;\n```\nafter with ```` four';
    const markdown = renderHandoffNote({ ...baseNote, report });
    expect(longestBacktickRun(report)).toBe(4);
    expect(markdown).toContain('`````text\n');
    expect(markdown).toContain(report);
    expect(parseHandoffNote(markdown).head).toBe(baseNote.head);
  });

  it('omits pr when none, tolerates CRLF, and downgrades unknown agents', () => {
    const markdown = renderHandoffNote({ ...baseNote, pr: undefined, agent: 'unknown', report: '' })
      .replace(/\n/gu, '\r\n');
    const parsed = parseHandoffNote(markdown);
    expect(parsed.pr).toBeUndefined();
    expect(parsed.agent).toBe('unknown');
    expect(markdown).toContain('no agent panel output captured');
  });

  it('rejects notes without front matter or required keys', () => {
    expect(() => parseHandoffNote('# Not a handoff')).toThrow(/front matter/u);
    expect(() => parseHandoffNote('---\npane: x\n---\n')).toThrow(/missing "branch"/u);
    expect(() => parseHandoffNote('---\npane: x\nbranch: y\n')).toThrow(/not terminated/u);
  });

  it('parses handoff targets', () => {
    expect(parseHandoffTarget('local')).toEqual({ kind: 'local' });
    expect(parseHandoffTarget(' remote:My VM ')).toEqual({ kind: 'remote', label: 'My VM' });
    expect(() => parseHandoffTarget('remote:')).toThrow(/--to/u);
    expect(() => parseHandoffTarget('cloud')).toThrow(/--to/u);
  });

  it('accepts plain branch names and refuses shell-hostile or malformed ones', () => {
    expect(isSafeBranchName('main')).toBe(true);
    expect(isSafeBranchName('feat/panes-handoff')).toBe(true);
    expect(isSafeBranchName('release-2.4.x')).toBe(true);
    for (const bad of ['-x', 'a..b', 'a b', 'x$(id)', 'a//b', '/lead', 'trail/', 'x.lock', '', 'x;rm']) {
      expect(isSafeBranchName(bad), bad).toBe(false);
    }
  });

  it('derives a flat directory name from a branch', () => {
    expect(worktreeDirectoryForBranch('feat/panes-handoff')).toBe('feat-panes-handoff');
    expect(worktreeDirectoryForBranch('main')).toBe('main');
  });

  it('builds a single-line instruction with no backticks or shell metacharacters', () => {
    const instruction = receiveInstruction(baseNote);
    expect(instruction).not.toMatch(/[`$;&|<>\n]/u);
    expect(instruction).toContain(baseNote.head);
    expect(instruction).toContain(baseNote.branch);
    expect(instruction).toContain('Delete HANDOFF.md before opening a pull request');
    expect(instruction).toContain('Do not push until asked');
  });

  it('builds the receive command with the source agent and quotes unusual names', () => {
    expect(receiveCommandFor({ repoName: 'Pane', branch: 'feat/x', agent: 'claude' }))
      .toBe('runpane panes receive --repo Pane --branch feat/x --agent claude --yes --json');
    expect(receiveCommandFor({ repoName: 'My Repo', branch: 'main', agent: 'unknown' }))
      .toBe("runpane panes receive --repo 'My Repo' --branch main --agent <codex|claude|cursor> --yes --json");
  });
});
