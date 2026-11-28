import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORCHESTRATION_SESSION_STORE_VERSION,
  type OrchestrationActivity,
  type OrchestrationSessionRecord,
} from '../../../../shared/types/orchestrationSession';
import type { AppServices } from '../../ipc/types';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { ConfigManager } from '../configManager';
import { OrchestrationSessionManager } from '../orchestrationSessionManager';
import { OrchestrationSessionStore } from '../orchestrationSessionStore';
import type { SessionManager } from '../sessionManager';
import type { Session } from '../../types/session';
import { createTodoHost } from './todoHost';

const SESSIONS = 50;
const ACTIVITY_PER_SESSION = 500;
/** The to-dos size budget's 400 open to-dos, each linked to a Session: trackedTabs looks each up twice per tick. */
const LOOKUPS_PER_TICK = 800;

function stub<Service>(value: Partial<Service>): Service {
  // SAFETY: Only the methods the Session lookup path reaches are provided; any other call fails at its site.
  return value as Service;
}

function record(index: number): OrchestrationSessionRecord {
  const at = '2026-11-16T12:00:00.000Z';
  const activity: OrchestrationActivity[] = Array.from({ length: ACTIVITY_PER_SESSION }, (_, row) => ({
    id: `s${index}-a${row}`, kind: 'report', message: `Progress ${row}: checked the build, the tests and the review comments.`, at, source: 'agent',
  }));
  return {
    id: `s${index}`, name: `Session ${index}`, agent: 'claude', internalSessionId: `__orchestration_session_${index}__`,
    panelIds: { claude: `o${index}`, codex: `c${index}`, cursor: `u${index}`, opencode: `p${index}`, pi: `i${index}`, agy: `a${index}` },
    goal: 'Ship it.', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
    associations: [{ paneId: `pane${index}`, panelIds: [], attachedAt: at }, { paneId: `gone${index}`, panelIds: [], attachedAt: at }],
    activity, revision: 1, createdAt: at, updatedAt: at,
  };
}

/** Real store, manager and host: the to-dos budget test fakes the host, so it can't see what a Session lookup costs. */
describe('to-dos Session lookup budget', () => {
  let directory: string;
  let manager: OrchestrationSessionManager;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-todo-session-budget-'));
    const store = new OrchestrationSessionStore(path.join(directory, 'orchestration-sessions.json'));
    store.write({ version: ORCHESTRATION_SESSION_STORE_VERSION, sessions: Array.from({ length: SESSIONS }, (_, index) => record(index)) });
    const panes = new Map(Array.from({ length: SESSIONS }, (_, index) => [`pane${index}`, stub<Session>({ id: `pane${index}`, archived: false })]));
    const sessionManager = stub<SessionManager>({ getSession: (id: string) => panes.get(id) });
    manager = new OrchestrationSessionManager(stub<ConfigManager>({}), sessionManager, undefined, undefined, undefined, store);
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('answers a tick of linked to-do Session lookups in under 200 ms', () => {
    const host = createTodoHost(stub<AppServices>({ orchestrationSessionManager: manager }), stub<PaneCommandRegistry>({}));
    expect(host.session('s7')).toEqual({ id: 's7', name: 'Session 7', orchestratorPanelId: 'o7', archived: false, paneIds: ['pane7'], agentId: 'claude' });
    expect(host.session('missing')).toBeNull();

    const start = performance.now();
    for (let index = 0; index < LOOKUPS_PER_TICK; index += 1) host.session(`s${index % SESSIONS}`);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(200);
  });
});
