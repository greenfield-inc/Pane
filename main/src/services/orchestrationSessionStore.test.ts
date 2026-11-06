import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_ORCHESTRATION_SESSION_ID,
  ORCHESTRATION_SESSION_STORE_VERSION,
  type OrchestrationSessionRecord,
  type OrchestrationSessionStoreData,
} from '../../../shared/types/orchestrationSession';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
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
      opencode: '__orchestration_panel_release_opencode',
      gemini: '__orchestration_panel_release_gemini',
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
  it('normalizes OpenCode panels, native runtime and Session order together without rewriting on read', () => {
    const filePath = createStorePath();
    const data = createData(createRecord({ agent: 'opencode', runtime: 'windows' }));
    data.order = ['missing-session', 'session-1', 'session-1'];
    fs.writeFileSync(filePath, JSON.stringify(data, (key, value) => key === 'opencode' ? undefined : value));
    const before = fs.readFileSync(filePath, 'utf8');
    const store = new OrchestrationSessionStore(filePath);

    const loaded = store.read();

    expect(loaded.sessions[0].agent).toBe('opencode');
    expect(loaded.sessions[0].panelIds.opencode).toBe('__orchestration_panel_session-1_opencode');
    expect(loaded.sessions[0]).not.toHaveProperty('runtime');
    expect(loaded.order).toEqual(['session-1']);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    store.write(loaded);
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(loaded);
  });

  it('normalizes old panel maps without rewriting', () => {
    const filePath = createStorePath();
    const data = createData();
    data.sessions.push(createRecord({ id: LEGACY_ORCHESTRATION_SESSION_ID, internalSessionId: PANE_CHAT_SESSION_ID }));
    data.sessions.push(createRecord({ id: `${LEGACY_ORCHESTRATION_SESSION_ID}-codex`, internalSessionId: PANE_CHAT_SESSION_ID }));
    // Sessions saved before OpenCode and Gemini joined have neither panel id.
    fs.writeFileSync(filePath, JSON.stringify(data, (key, value) => key === 'opencode' || key === 'gemini' ? undefined : value));
    const before = fs.readFileSync(filePath, 'utf8');

    const loaded = new OrchestrationSessionStore(filePath).read();

    expect(loaded.version).toBe(1);
    expect(loaded.sessions.map(record => record.panelIds.opencode)).toEqual([
      '__orchestration_panel_session-1_opencode',
      '__pane_chat_terminal_opencode__',
      '__orchestration_panel_legacy-pane-chat-codex_opencode',
    ]);
    expect(loaded.sessions.map(record => record.panelIds.gemini)).toEqual([
      '__orchestration_panel_session-1_gemini',
      '__pane_chat_terminal_gemini__',
      '__orchestration_panel_legacy-pane-chat-codex_gemini',
    ]);
    expect(loaded.sessions.map(record => ({ ...record.panelIds, opencode: undefined, gemini: undefined })))
      .toEqual(data.sessions.map(record => ({ ...record.panelIds, opencode: undefined, gemini: undefined })));
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);

    const store = new OrchestrationSessionStore(filePath);
    store.write(loaded);
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(loaded);
  });

  it('preserves supplied OpenCode mappings and selection across roundtrips', () => {
    const filePath = createStorePath();
    const record = createRecord({ agent: 'opencode' });
    record.panelIds.opencode = '  custom-opencode-panel  ';
    const data = createData(record);
    fs.writeFileSync(filePath, JSON.stringify(data));
    const before = fs.readFileSync(filePath, 'utf8');
    const store = new OrchestrationSessionStore(filePath);

    expect(store.read()).toEqual(data);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    store.write(store.read());
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(data);
  });

  it.each([15_969, 15_970, 16_000])('roundtrips old panel maps with a previously valid %i-character Session id', length => {
    const filePath = createStorePath();
    const id = 'x'.repeat(length);
    const data = createData(createRecord({ id }));
    fs.writeFileSync(filePath, JSON.stringify(data, (key, value) => key === 'opencode' ? undefined : value));
    const before = fs.readFileSync(filePath, 'utf8');
    const store = new OrchestrationSessionStore(filePath);

    const loaded = store.read();
    expect(loaded.sessions[0].panelIds.opencode).toBe(`__orchestration_panel_${id}_opencode`);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    store.write(loaded);
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(loaded);
  });

  it('treats JSON __proto__ as data rather than adopting an inherited OpenCode mapping', () => {
    const filePath = createStorePath();
    const record = createRecord();
    const data = createData(record);
    const panelIds = {
      claude: record.panelIds.claude, codex: record.panelIds.codex, cursor: record.panelIds.cursor,
      ['__proto__']: { opencode: 'foreign-panel' },
    };
    fs.writeFileSync(filePath, JSON.stringify({ ...data, sessions: [{ ...record, panelIds }] }));
    const before = fs.readFileSync(filePath, 'utf8');
    const store = new OrchestrationSessionStore(filePath);

    const loaded = store.read();
    expect(loaded.sessions[0].panelIds.opencode).toBe('__orchestration_panel_session-1_opencode');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    store.write(loaded);
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(loaded);
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('foreign-panel');
  });

  it('ignores inherited OpenCode mappings on direct writes and rejects inherited required mappings', () => {
    const filePath = createStorePath();
    const data = createData();
    const panelIds = data.sessions[0].panelIds;
    Object.setPrototypeOf(panelIds, { opencode: 'foreign-panel', claude: panelIds.claude });
    Reflect.deleteProperty(panelIds, 'opencode');
    const store = new OrchestrationSessionStore(filePath);

    store.write(data);
    expect(store.read().sessions[0].panelIds.opencode).toBe('__orchestration_panel_session-1_opencode');
    const before = fs.readFileSync(filePath, 'utf8');
    expect(before).not.toContain('foreign-panel');
    Reflect.deleteProperty(panelIds, 'claude');
    expect(() => store.write(data)).toThrow('panelIds.claude');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it.each([
    ['empty', ''], ['whitespace', ' \t '], ['null', null], ['number', 42],
    ['boolean', false], ['object', {}], ['array', []],
  ])('refuses a malformed OpenCode mapping on write and repairs it on read: %s', (_label, value) => {
    const filePath = createStorePath();
    const initial = createData();
    const store = new OrchestrationSessionStore(filePath);
    store.write(initial);
    const before = fs.readFileSync(filePath, 'utf8');
    const malformed = createData();
    Reflect.set(malformed.sessions[0].panelIds, 'opencode', value);

    expect(() => store.write(malformed)).toThrow('invalid OpenCode panel id');
    expect(store.read()).toEqual(initial);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);

    fs.writeFileSync(filePath, JSON.stringify(malformed));
    const malformedBytes = fs.readFileSync(filePath, 'utf8');
    const loaded = new OrchestrationSessionStore(filePath).read();
    expect(loaded.sessions[0].panelIds).toEqual({ ...initial.sessions[0].panelIds, opencode: '__orchestration_panel_session-1_opencode' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(malformedBytes);
  });

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

  it('starts empty from a file that is not JSON, keeping the original until the next write', () => {
    const filePath = createStorePath();
    fs.writeFileSync(filePath, '{"version":1,"sessions":[', { mode: 0o600 });
    const store = new OrchestrationSessionStore(filePath);

    expect(store.read().sessions).toEqual([]);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"version":1,"sessions":[');
    store.write(createData());

    const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.startsWith('orchestration-sessions.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(filePath), backups[0]), 'utf8')).toBe('{"version":1,"sessions":[');
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(createData());
  });

  it('salvages the Sessions of a store with another version or a bad envelope', () => {
    const filePath = createStorePath();
    const raw = JSON.stringify({ version: 2, selectedSessionId: 42, order: 'session-1', sessions: [createRecord()] });
    fs.writeFileSync(filePath, raw);
    const store = new OrchestrationSessionStore(filePath);

    expect(store.read()).toEqual({ version: ORCHESTRATION_SESSION_STORE_VERSION, sessions: [createRecord()] });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(raw);
    store.write(createData());
    expect(new OrchestrationSessionStore(filePath).read()).toEqual(createData());
    const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.includes('.corrupt-'));
    expect(fs.readFileSync(path.join(path.dirname(filePath), backups[0]), 'utf8')).toBe(raw);
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
