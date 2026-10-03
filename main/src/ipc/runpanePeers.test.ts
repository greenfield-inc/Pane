import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMailbox } from '../services/agentMailbox';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PaneDaemonServer } from '../daemon/server';
import { invokeDaemon } from '../../../packages/runpane/src/daemonClient';
import { boundary } from '../../../shared/validation/boundaryDecoder';
import { registerPeerHandlers } from './runpanePeers';

// SAFETY: Node owns the node:sqlite builtin; this is its published module type.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup(managedWorker = false) {
  const db = new DatabaseSync(':memory:');
  const mailbox = new AgentMailbox(db);
  cleanup.push(() => { mailbox.dispose(); db.close(); });
  const registry = new PaneCommandRegistry();
  registerPeerHandlers(registry, { agentMailbox: mailbox, databaseService: { getDb: () => { throw new Error('Unexpected database reopen'); } } }, {
    listManagedCliPanels: () => managedWorker ? [{ panelId: 'worker', paneId: 'pane-1', paneName: 'Worker', agentState: 'idle' }] : [],
  }, { isTerminalInitialized: () => true });
  return { registry, call: (request: Record<string, string | boolean | number>) => registry.invoke('runpane:peers', [request]) };
}

describe('peer command protocol', () => {
  it('binds a terminal wake and the resulting inbox claim to the requested message', async () => {
    const { call, registry } = setup(true);
    let cue = '';
    registry.register('runpane:panels:screen', () => ({ state: { isCliReady: true }, composer: { isPresent: true, hasUndeliveredText: false } }));
    registry.register('runpane:panels:submit', (request: { panelId: string; input: string }) => { cue = request.input; return { ok: true }; });
    await call({ action: 'register', peer: 'sender', confirmed: true });
    for (const id of ['task-a', 'task-b']) await call({ action: 'send', peer: 'sender', to: 'worker', id, text: id, confirmed: true });
    await call({ action: 'wake', peer: 'sender', id: 'task-b', confirmed: true });
    expect(cue).toContain('inbox --peer worker --id task-b --claim');
    expect(await call({ action: 'inbox', peer: 'worker', id: 'task-b', claim: true, confirmed: true }))
      .toMatchObject({ messages: [{ id: 'task-b', status: 'received' }] });
    expect(await call({ action: 'inbox', peer: 'worker' })).toMatchObject({ messages: [{ id: 'task-a', status: 'queued' }] });
  });

  it('discovers unregistered callers and arbitrary agent labels without pretending they have native delivery', async () => {
    const { call } = setup();
    expect(await call({ action: 'self' })).toMatchObject({ protocolVersion: 1, identity: null, peer: null });
    await call({ action: 'register', peer: 'custom', agent: 'unlisted-runtime', confirmed: true });
    expect(await call({ action: 'self', peer: 'custom' })).toMatchObject({ peer: {
      agent: 'unlisted-runtime', receiver: 'cooperative', capabilities: { mailbox: true, automaticDelivery: false, terminalFallback: false },
    } });
    await expect(call({ action: 'register', peer: 'other' })).rejects.toThrow('--yes');
    await expect(call({ action: 'inbox', peer: 'unknown' })).rejects.toThrow('register');
    await expect(call({ action: 'invalid' })).rejects.toThrow();
  });

  it('keeps prompt text out of receipts and rejects unknown or wrong participants', async () => {
    const { call } = setup();
    for (const peer of ['sender', 'worker']) await call({ action: 'register', peer, confirmed: true });
    const sent = await call({ action: 'send', peer: 'sender', to: 'worker', id: 'task-1', text: 'Private long task', confirmed: true });
    expect(sent).toMatchObject({ message: { status: 'queued' }, duplicate: false });
    expect(JSON.stringify(sent)).not.toContain('Private long task');
    await expect(call({ action: 'send', peer: 'sender', to: 'unknown', id: 'task-2', text: 'Task', confirmed: true })).rejects.toThrow('Unknown recipient');
    await call({ action: 'inbox', peer: 'worker', claim: true, confirmed: true });
    await expect(call({ action: 'reply', peer: 'sender', id: 'task-1', status: 'completed', text: 'Done', confirmed: true })).rejects.toThrow('recipient');
    await call({ action: 'reply', peer: 'worker', id: 'task-1', status: 'completed', text: 'Commit abc, QA passed', confirmed: true });
    const result = await call({ action: 'wait', peer: 'sender', id: 'task-1', timeoutMs: 0 });
    expect(result).toMatchObject({ timedOut: false, message: { status: 'completed', revision: 3 } });
    expect(JSON.stringify(result)).not.toContain('Private long task');
  });

  it('serves correlated waits through the real daemon socket transport', async () => {
    const { registry } = setup();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-peer-transport-'));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const server = new PaneDaemonServer(registry, directory);
    await server.start();
    cleanup.push(() => server.stop());
    const call = (request: Record<string, string | boolean | number>) => invokeDaemon('runpane:peers', [request], boundary.jsonObject, { paneDir: directory, eventInclude: [] });
    for (const peer of ['sender', 'worker']) await call({ action: 'register', peer, confirmed: true });
    await call({ action: 'send', peer: 'sender', to: 'worker', id: 'socket-task', text: 'Task', confirmed: true });
    const waiting = call({ action: 'wait', peer: 'sender', id: 'socket-task', timeoutMs: 2000 });
    await call({ action: 'inbox', peer: 'worker', claim: true, confirmed: true });
    await call({ action: 'reply', peer: 'worker', id: 'socket-task', status: 'completed', text: 'Done', confirmed: true });
    expect(await waiting).toMatchObject({ timedOut: false, message: { id: 'socket-task', status: 'completed' } });
  });
});
