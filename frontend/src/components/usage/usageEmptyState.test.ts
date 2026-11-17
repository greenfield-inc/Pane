import { describe, expect, it } from 'vitest';
import { hasNoAgentTranscripts } from './usageEmptyState';
import type { UsageIndexStatus } from '../../../../shared/types/usage';

// The four roots the main process indexes (usageManager.ts `transcriptRoots`).
const CLAUDE_HOME = '/home/dev/.claude/projects';
const CODEX_HOME = '/home/dev/.codex/sessions';
const CLAUDE_LOGS = '/home/dev/.pane/agent-logs/claude';
const CODEX_LOGS = '/home/dev/.pane/agent-logs/codex';

function index(overrides: Partial<UsageIndexStatus> = {}): UsageIndexStatus {
  return {
    lastScanStartedMs: 1, lastScanFinishedMs: 2, filesTracked: 12, eventsIndexed: 840, missingRoots: [],
    scanning: false, filesScanned: 0, filesTotal: 0, lastError: null,
    ...overrides,
  };
}

describe('hasNoAgentTranscripts', () => {
  it('shows the report when only ~/.claude/projects exists and has events', () => {
    expect(hasNoAgentTranscripts(index({ missingRoots: [CODEX_HOME, CLAUDE_LOGS, CODEX_LOGS] }))).toBe(false);
  });

  it('shows the report when only Codex exists and has events', () => {
    expect(hasNoAgentTranscripts(index({ missingRoots: [CLAUDE_HOME, CLAUDE_LOGS, CODEX_LOGS] }))).toBe(false);
  });

  it('shows the empty state when no root exists and nothing is indexed', () => {
    const empty = index({ filesTracked: 0, eventsIndexed: 0, missingRoots: [CLAUDE_HOME, CODEX_HOME, CLAUDE_LOGS, CODEX_LOGS] });
    expect(hasNoAgentTranscripts(empty)).toBe(true);
  });

  it('waits for a running scan before calling the index empty', () => {
    const scanning = index({ filesTracked: 0, eventsIndexed: 0, missingRoots: [CODEX_HOME, CLAUDE_LOGS, CODEX_LOGS], scanning: true });
    expect(hasNoAgentTranscripts(scanning)).toBe(false);
  });

  it('shows the report when every root exists, even before anything is indexed', () => {
    expect(hasNoAgentTranscripts(index({ eventsIndexed: 0 }))).toBe(false);
    expect(hasNoAgentTranscripts(undefined)).toBe(false);
  });
});
