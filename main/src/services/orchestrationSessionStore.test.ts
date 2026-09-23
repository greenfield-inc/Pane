import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORCHESTRATION_SESSION_STORE_VERSION,
  type OrchestrationSessionRecord,
  type OrchestrationSessionStoreData,
} from '../../../shared/types/orchestrationSession';
import { OrchestrationSessionStore } from './orchestrationSessionStore';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createStorePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-orchestration-sessions-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'orchestration-sessions.json');
}

function createRecord(overrides: Partial<OrchestrationSessionRecord> = {}): OrchestrationSessionRecord {
  const timestamp = '2026-09-16T12:00:00.000Z';
  return {
    id: 'session-1',
    name: 'Release review',
    agent: 'claude',
    internalSessionId: '__orchestration_session_release__',
    panelIds: {
      claude: '__orchestration_panel_release_claude',
      codex: '__orchestration_panel_release_codex',
      cursor: '__orchestration_panel_release_cursor',
    },
    goal: 'Review the release evidence.',
    context: 'Use the current branch and attached Panes.',
    decisions: ['Keep the report attributed to the source.'],
    blockers: [],
    nextAction: 'Inspect the latest checks.',
    evidence: [],
    outputs: [],
    associations: [],
    activity: [{
      id: 'activity-1',
      kind: 'created',
      message: 'Created Session.',
      at: timestamp,
      source: 'user',
    }],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createData(record = createRecord()): OrchestrationSessionStoreData {
  return {
    version: ORCHESTRATION_SESSION_STORE_VERSION,
    selectedSessionId: record.id,
    sessions: [record],
  };
}

describe('OrchestrationSessionStore', () => {
  it('persists validated records through a private atomic file', () => {
    const filePath = createStorePath();
    const store = new OrchestrationSessionStore(filePath);

    store.write(createData());

    expect(new OrchestrationSessionStore(filePath).read()).toEqual(createData());
    if (process.platform !== 'win32') expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['orchestration-sessions.json']);
  });

  it('does not silently replace malformed persisted metadata', () => {
    const filePath = createStorePath();
    fs.writeFileSync(filePath, '{"version":1,"sessions":[', { mode: 0o600 });
    const store = new OrchestrationSessionStore(filePath);

    expect(() => store.read()).toThrow(`Unable to read orchestration Session store ${filePath}`);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"version":1,"sessions":[');
  });

  it('rejects unsafe links and evidence-free reports at the persistence boundary', () => {
    const filePath = createStorePath();
    const store = new OrchestrationSessionStore(filePath);
    const unsafeEvidence = [{
      label: 'Local command',
      url: 'javascript:alert(1)',
      addedAt: '2026-09-16T12:00:00.000Z',
    }];
    const reportWithoutEvidence = {
      summary: 'Done',
      status: 'reported' as const,
      evidence: [],
      reportedAt: '2026-09-16T12:00:00.000Z',
      provenance: 'agent',
    };

    expect(() => store.write(createData(createRecord({ evidence: unsafeEvidence })))).toThrow('must use https, file, or grain scheme');
    expect(() => store.write(createData(createRecord({ report: reportWithoutEvidence })))).toThrow('report needs evidence');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects an oversized record before changing the existing snapshot', () => {
    const filePath = createStorePath();
    const store = new OrchestrationSessionStore(filePath);
    const initial = createData();
    store.write(initial);
    const oversized = createRecord({ context: 'x'.repeat(16_001) });

    expect(() => store.write(createData(oversized))).toThrow('exceeds text limit');
    expect(store.read()).toEqual(initial);
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(initial);
  });

  it('rejects a selected Session that is missing from the record set', () => {
    const filePath = createStorePath();
    const store = new OrchestrationSessionStore(filePath);

    expect(() => store.write({
      version: ORCHESTRATION_SESSION_STORE_VERSION,
      selectedSessionId: 'missing',
      sessions: [createRecord()],
    })).toThrow('selects missing Session missing');
  });
});
