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
    fs.writeFileSync(filePath, JSON.stringify(data, (key, value) => key === 'opencode' ? undefined : value));
    const before = fs.readFileSync(filePath, 'utf8');

    const loaded = new OrchestrationSessionStore(filePath).read();

    expect(loaded.version).toBe(1);
    expect(loaded.sessions.map(record => record.panelIds.opencode)).toEqual([
      '__orchestration_panel_session-1_opencode',
      '__pane_chat_terminal_opencode__',
      '__orchestration_panel_legacy-pane-chat-codex_opencode',
    ]);
    expect(loaded.sessions.map(record => ({ ...record.panelIds, opencode: undefined })))
      .toEqual(data.sessions.map(record => ({ ...record.panelIds, opencode: undefined })));
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

  it.each(['x'.repeat(16_001), `__orchestration_panel_${'x'.repeat(16_000)}_openCodE`])(
    'rejects an arbitrary oversized mapping even for a valid maximum-length Session id', opencode => {
      const filePath = createStorePath();
      const data = createData(createRecord({ id: 'x'.repeat(16_000) }));
      data.sessions[0].panelIds.opencode = opencode;
      expect(() => new OrchestrationSessionStore(filePath).write(data)).toThrow('panel id exceeds text limit');
      expect(fs.existsSync(filePath)).toBe(false);
      fs.writeFileSync(filePath, JSON.stringify(data));
      const before = fs.readFileSync(filePath, 'utf8');
      expect(() => new OrchestrationSessionStore(filePath).read()).toThrow('panel id exceeds text limit');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    },
  );

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
    ['boolean', false], ['object', {}], ['array', []], ['oversized', 'x'.repeat(16_001)],
  ])('rejects malformed OpenCode mappings on read and write: %s', (_label, value) => {
    const filePath = createStorePath();
    const initial = createData();
    const store = new OrchestrationSessionStore(filePath);
    store.write(initial);
    const before = fs.readFileSync(filePath, 'utf8');
    const malformed = createData();
    Reflect.set(malformed.sessions[0].panelIds, 'opencode', value);

    expect(() => store.write(malformed)).toThrow();
    expect(store.read()).toEqual(initial);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['orchestration-sessions.json']);

    fs.writeFileSync(filePath, JSON.stringify(malformed));
    const malformedBytes = fs.readFileSync(filePath, 'utf8');
    expect(() => new OrchestrationSessionStore(filePath).read()).toThrow();
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
