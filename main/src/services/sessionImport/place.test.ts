import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placeSessions, type PlacementPort, type TabCheck } from './place';
import type { ScannedSession } from './scan';

let root: string;
let stores = { claudeConfigDir: '', codexHome: '' };
let paneDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-import-place-'));
  stores = { claudeConfigDir: path.join(root, 'claude'), codexHome: path.join(root, 'codex') };
  paneDir = path.join(root, 'pane');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A Claude transcript in the person's own store, as Claude Code lays it out. */
function claudeTranscript(sessionId: string): void {
  const file = path.join(stores.claudeConfigDir, 'projects', '-repo', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
}

function session(sessionId: string, checkout: string, overrides: Partial<ScannedSession> = {}): ScannedSession {
  return {
    key: `claude:${sessionId}`, source: 'claude', agent: 'claude', sessionId, title: sessionId,
    folder: checkout, checkout, repoRoot: '/repo', repoName: 'repo',
    lastActiveMs: 0, running: 'no', alreadyInPane: false, preselected: true, ...overrides,
  };
}

/** Records every call; tabs check as `checks` says, ready by default. */
function fakePort(checks: Record<string, TabCheck> = {}, existing: Record<string, string> = {}) {
  const calls: string[] = [];
  const resumeOf = new Map<string, string>();
  let next = 0;
  const port: PlacementPort = {
    addRepo: async repoRoot => { calls.push(`repo ${repoRoot}`); return 7; },
    paneForCheckout: checkout => existing[checkout] ? { paneId: existing[checkout], name: 'existing' } : undefined,
    adopt: async (repoId, checkout, name, agent, resume) => {
      const ids = { paneId: `pane-${++next}`, panelId: `tab-${resume}` };
      calls.push(`adopt ${repoId} ${checkout} as ${name} ${agent} --resume ${resume}`);
      resumeOf.set(ids.panelId, resume);
      return ids;
    },
    addTab: async (paneId, agent, resume) => {
      calls.push(`tab ${paneId} ${agent} --resume ${resume}`);
      resumeOf.set(`tab-${resume}`, resume);
      return { panelId: `tab-${resume}` };
    },
    storedResumeId: panelId => resumeOf.get(panelId),
    waitReady: async panelId => checks[panelId.replace('tab-', '')] ?? { state: 'ready' },
    closeTab: async panelId => { calls.push(`close ${panelId}`); },
    rollbackPane: async paneId => { calls.push(`rollback ${paneId}`); },
  };
  return { port, calls };
}

function readRecord(): Array<Record<string, string | null>> {
  return JSON.parse(fs.readFileSync(path.join(paneDir, 'migrate-to-pane', 'record.json'), 'utf8')).sessions;
}

describe('placeSessions', () => {
  it('adopts each checkout once and opens one tab per further session', async () => {
    for (const id of ['a', 'b', 'c']) claudeTranscript(id);
    const { port, calls } = fakePort();

    const result = await placeSessions({ sessions: [session('a', '/repo'), session('b', '/repo'), session('c', '/repo-wt')], port, stores, paneDir });

    expect(calls).toEqual([
      'repo /repo',
      'adopt 7 /repo as repo claude --resume a',
      'tab pane-1 claude --resume b',
      'adopt 7 /repo-wt as repo-wt claude --resume c',
    ]);
    expect(result.panesCreated).toBe(2);
    expect(result.tabsInExistingPanes).toBe(0);
    expect(result.results.map(entry => [entry.key, entry.outcome, entry.paneId])).toEqual([
      ['claude:a', 'continued', 'pane-1'],
      ['claude:b', 'continued', 'pane-1'],
      ['claude:c', 'continued', 'pane-2'],
    ]);
    expect(readRecord().map(entry => [entry.tool, entry.id, entry.result, entry.paneId, entry.source])).toEqual([
      ['claude', 'a', 'continued', 'pane-1', 'claude'],
      ['claude', 'b', 'continued', 'pane-1', 'claude'],
      ['claude', 'c', 'continued', 'pane-2', 'claude'],
    ]);
  });

  it('adds tabs to a Pane that already owns the checkout', async () => {
    claudeTranscript('a');
    const { port, calls } = fakePort({}, { '/repo': 'pane-old' });

    const result = await placeSessions({ sessions: [session('a', '/repo')], port, stores, paneDir });

    expect(calls).toEqual(['repo /repo', 'tab pane-old claude --resume a']);
    expect(result).toMatchObject({ panesCreated: 0, tabsInExistingPanes: 1 });
  });

  it('copies a transcript from a tool-managed agent folder into the person\'s store once, leaving the source alone', async () => {
    const toolHome = path.join(root, 'orca', 'claude-home');
    const source = path.join(toolHome, 'projects', '-repo', 'm.jsonl');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, '{"type":"user"}\n');
    const before = fs.statSync(source).mtimeMs;
    const { port } = fakePort();

    await placeSessions({ sessions: [session('m', '/repo', { source: 'orca', transcript: { agentHome: toolHome, path: source } })], port, stores, paneDir });

    expect(fs.readFileSync(path.join(stores.claudeConfigDir, 'projects', '-repo', 'm.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
    expect(fs.readFileSync(source, 'utf8')).toBe('{"type":"user"}\n');
    expect(fs.statSync(source).mtimeMs).toBe(before);
  });

  it('reports a session with no transcript anywhere as not continued and creates nothing for it', async () => {
    const { port, calls } = fakePort();

    const result = await placeSessions({ sessions: [session('lost', '/repo')], port, stores, paneDir });

    expect(calls).toEqual([]);
    expect(result.results[0]).toMatchObject({ outcome: 'not continued', reason: 'Claude Code has no saved conversation with this id on this computer, so there is nothing to resume.' });
    expect(readRecord()[0]).toMatchObject({ id: 'lost', result: 'not continued', paneId: null });
  });

  it('closes a failed tab and rolls back a new Pane whose sessions all failed', async () => {
    for (const id of ['x', 'y', 'z']) claudeTranscript(id);
    const { port, calls } = fakePort({ x: { state: 'failed', reason: 'it exited' }, y: { state: 'failed', reason: 'it exited' } });

    const result = await placeSessions({ sessions: [session('x', '/one'), session('y', '/two'), session('z', '/two')], port, stores, paneDir });

    expect(calls.filter(call => call.startsWith('close') || call.startsWith('rollback'))).toEqual(['close tab-x', 'close tab-y', 'rollback pane-1']);
    expect(result.panesCreated).toBe(1);
    expect(result.results.map(entry => entry.outcome)).toEqual(['not continued', 'not continued', 'continued']);
    expect(result.results[0].reason).toBe("Claude Code didn't resume it: it exited. Say 'migrate to Pane' in Pane Chat to try it another way.");
  });

  it('leaves a tab waiting at the folder-trust prompt open for the person', async () => {
    claudeTranscript('t');
    const { port, calls } = fakePort({ t: { state: 'trust' } });

    const result = await placeSessions({ sessions: [session('t', '/repo')], port, stores, paneDir });

    expect(calls.some(call => call.startsWith('close') || call.startsWith('rollback'))).toBe(false);
    expect(result.results[0]).toMatchObject({ outcome: 'waiting for trust', paneId: 'pane-1' });
    expect(result.panesCreated).toBe(1);
    expect(readRecord()[0]).toMatchObject({ result: 'pending', panelId: 'tab-t' });
  });

  it('keeps a slow agent\'s tab open and reports it as still starting', async () => {
    claudeTranscript('slow');
    const { port, calls } = fakePort({ slow: { state: 'starting' } });

    const result = await placeSessions({ sessions: [session('slow', '/repo')], port, stores, paneDir });

    expect(calls.some(call => call.startsWith('close') || call.startsWith('rollback'))).toBe(false);
    expect(result).toMatchObject({ panesCreated: 1, results: [{ outcome: 'still starting', paneId: 'pane-1' }] });
    expect(readRecord()[0]).toMatchObject({ result: 'pending' });
  });
});
