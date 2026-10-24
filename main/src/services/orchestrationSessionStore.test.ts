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
  it('omits the native runtime, drops a legacy "windows" value, and preserves a WSL runtime across reloads', () => {
    const filePath = createStorePath();
    fs.writeFileSync(filePath, JSON.stringify(createData()));
    expect(new OrchestrationSessionStore(filePath).read().sessions[0]).not.toHaveProperty('runtime');
    fs.writeFileSync(filePath, JSON.stringify(createData(createRecord({ runtime: 'windows' }))));
    const store = new OrchestrationSessionStore(filePath);
    expect(store.read().sessions[0]).not.toHaveProperty('runtime');
    store.write(createData(createRecord({ runtime: 'windows' })));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[0]).not.toHaveProperty('runtime');
    store.write(createData(createRecord({ runtime: 'wsl', wslDistribution: 'Ubuntu' })));
    expect(new OrchestrationSessionStore(filePath).read().sessions[0]).toMatchObject({
      runtime: 'wsl', wslDistribution: 'Ubuntu',
    });
    expect(() => store.write(createData(createRecord({ runtime: 'wsl' })))).toThrow('distribution');
  });
  it('persists validated records through a private atomic file', () => {
    const filePath = createStorePath();
    const store = new OrchestrationSessionStore(filePath);

    store.write(createData());

    expect(new OrchestrationSessionStore(filePath).read()).toEqual(createData());
    if (process.platform !== 'win32') expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['orchestration-sessions.json']);
  });

  it('copies an unparseable file aside and starts fresh', () => {
    const filePath = createStorePath();
    fs.writeFileSync(filePath, '{"version":1,"sessions":[', { mode: 0o600 });
    const store = new OrchestrationSessionStore(filePath);

    expect(store.read().sessions).toEqual([]);
    store.write(createData());

    const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.startsWith('orchestration-sessions.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(filePath), backups[0]), 'utf8')).toBe('{"version":1,"sessions":[');
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(createData());
  });

  it('drops bad entries, keeps the rest, and saves the original file aside', () => {
    const filePath = createStorePath();
    const good = createRecord({ id: 'good' });
    const repaired = createRecord({
      id: 'repaired',
      evidence: [
        { label: 'Script', url: 'javascript:alert(1)', addedAt: '2026-09-16T12:00:00.000Z' },
        { label: 'PR', url: 'https://github.com/o/r/pull/1', addedAt: '2026-09-16T12:00:00.000Z' },
      ],
      activity: [
        { id: 'a1', kind: 'working', message: 'Working.', at: 'not a date', source: 'system' },
        { id: 'a2', kind: 'idle', message: 'Idle.', at: '2026-09-16T12:01:00.000Z', source: 'system' },
      ],
    });
    const broken = { ...createRecord({ id: 'broken' }), name: '' };
    const raw = JSON.stringify({
      version: ORCHESTRATION_SESSION_STORE_VERSION,
      selectedSessionId: 'broken',
      sessions: [good, repaired, broken],
    });
    fs.writeFileSync(filePath, raw);
    const store = new OrchestrationSessionStore(filePath);

    const data = store.read();
    expect(data.sessions.map(session => session.id)).toEqual(['good', 'repaired']);
    expect(data.selectedSessionId).toBeUndefined();
    expect(data.sessions[1].evidence.map(link => link.label)).toEqual(['PR']);
    expect(data.sessions[1].activity.map(entry => entry.id)).toEqual(['a2']);
    store.write({ ...data, selectedSessionId: 'good' });
    expect(new OrchestrationSessionStore(filePath).read().selectedSessionId).toBe('good');
    const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.includes('.corrupt-'));
    expect(fs.readFileSync(path.join(path.dirname(filePath), backups[0]), 'utf8')).toBe(raw);
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

  it('loads and writes a store of any size', () => {
    const filePath = createStorePath();
    const activity = Array.from({ length: 300 }, (_, index) => ({
      id: `activity-${index}`, kind: 'working' as const, message: 'x'.repeat(200), at: '2026-09-16T12:00:00.000Z', source: 'system' as const,
    }));
    const sessions = Array.from({ length: 150 }, (_, index) => createRecord({ id: `session-${index}`, activity, context: 'y'.repeat(20_000) }));
    fs.writeFileSync(filePath, JSON.stringify({ version: ORCHESTRATION_SESSION_STORE_VERSION, sessions }));
    expect(fs.statSync(filePath).size).toBeGreaterThan(2_000_000);
    const store = new OrchestrationSessionStore(filePath);

    const data = store.read();
    expect(data.sessions).toHaveLength(150);
    store.write({ ...data, sessions: [...data.sessions, createRecord({ id: 'one-more' })] });
    expect(new OrchestrationSessionStore(filePath).read().sessions).toHaveLength(151);
  });

  it('rejects a write that selects a Session missing from the record set', () => {
    const filePath = createStorePath();
    const store = new OrchestrationSessionStore(filePath);

    expect(() => store.write({
      version: ORCHESTRATION_SESSION_STORE_VERSION,
      selectedSessionId: 'missing',
      sessions: [createRecord()],
    })).toThrow('missing Session missing');
  });
});
