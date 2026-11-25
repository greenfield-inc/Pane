import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { hashDeviceToken } from './auth';
import type { ChatPanelState } from '../../../shared/types/chatTab';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { isDaemonOwnedChannel } from './daemonChannels';
import { PaneCommandRegistry, readOnlyPaneCaller } from './commandRegistry';
import { PaneRemoteHttpApiServer, type WorkspaceAccessPolicy } from './httpApiServer';
import { confirmedSharers } from './relay/confirmedSharers';
import { isPaneDaemonEventChannel } from './server';

// The commands and events a second person may read, as the plan approved them (D-169). The host's
// list is compared with this one, so widening it is a reviewed change to this file too.
const READABLE = [
  'chat-tab:agents', 'chat-tab:get', 'chat-tab:history', 'folders:get-by-project', 'loops:list',
  'mission-control:list-agents', 'mission-control:snapshots',
  'orchestration-sessions:activity-list', 'orchestration-sessions:get', 'orchestration-sessions:list', 'orchestration-sessions:overview',
  'panels:agent-statuses', 'panels:checkInitialized', 'panels:get-conversation-messages', 'panels:get-layout', 'panels:get-prompts', 'panels:getActive', 'panels:list',
  'projects:get-active', 'projects:get-all', 'relay:client:computer', 'relay:client:computers', 'remote:pwa-affordances',
  'runpane:loops:list', 'runpane:panels:last-message', 'runpane:panels:list', 'runpane:panels:output', 'runpane:panels:screen',
  'runpane:panes:list', 'runpane:panes:overview', 'runpane:repos:list', 'runpane:sessions:get', 'runpane:sessions:list', 'runpane:sessions:overview',
  'runpane:todos:list', 'runpane:todos:show', 'runpane:workspace:state', 'runpane:workspaces:describe',
  'sessions:get', 'sessions:get-all', 'sessions:get-all-with-projects', 'sessions:get-archived-with-projects', 'sessions:get-conversation',
  'sessions:get-conversation-message-count', 'sessions:get-conversation-messages', 'sessions:get-pane-order',
  'terminal:getAltScreenState', 'terminal:getScrollbackClean', 'terminal:getState', 'todos:detail', 'todos:snapshot',
];
/** A viewer's bookkeeping, answered without running. */
const ANSWERED = [
  'panels:initialize', 'panels:resize-terminal', 'panels:set-active', 'sessions:mark-viewed',
  'terminal:ack', 'terminal:reply', 'terminal:resetFlowControl', 'terminal:resize', 'terminal:setVisibility',
];
const READABLE_EVENTS = [
  'chat-tab:event', 'chat-tab:state', 'chat-tab:view', 'folder:created', 'folder:deleted', 'folder:updated', 'git-status-loading', 'git-status-updated', 'loops:changed',
  'orchestration-sessions:activity', 'orchestration-sessions:changed', 'orchestration-sessions:overview-updated',
  'panel:activityStatus', 'panel:agentStatus', 'panel:created', 'panel:deleted', 'panel:event', 'panel:prompt-added', 'panel:response-added', 'panel:updated',
  'project:list-changed', 'project:updated', 'session:created', 'session:creation-failed', 'session:deleted', 'session:updated', 'sessions:loaded',
  'terminal:alternateScreen', 'terminal:cliReady', 'terminal:exited', 'terminal:output', 'terminal:ptyReady', 'terminal:relaunched', 'todos:changed',
];

/** Every channel-shaped string in the host's source: the commands it registers and the events it sends. */
function namedInSource(owned: (name: string) => boolean): string[] {
  const names = new Set<string>();
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'accessLevel.ts') {
        for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(/['"`]([a-z][a-z-]*[:-][A-Za-z0-9:_-]+)['"`]/gu)) if (owned(name)) names.add(name);
      }
    }
  };
  walk(path.join(__dirname, '..'));
  walk(path.join(__dirname, '../../../shared'));
  return [...names];
}

const servers: PaneRemoteHttpApiServer[] = [];
afterEach(async () => { confirmedSharers.clear(); for (const server of servers.splice(0)) await server.stop(); });

function readerConfig(): RemoteDaemonConfig {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0, pairingRequired: true };
  const createdAt = '2026-11-25T00:00:00.000Z';
  config.host.clients = [
    { id: 'reader', label: 'Parsa', createdAt, kind: 'computer', computerId: 'parsa', access: 'read', tokenHash: hashDeviceToken('pane_read_token', 'read') },
    { id: 'owner', label: 'Own Mac', createdAt, kind: 'computer', computerId: 'mac', tokenHash: hashDeviceToken('owner-token') },
  ];
  return config;
}

async function serve(registry: PaneCommandRegistry, config = readerConfig(), workspace?: { access(): WorkspaceAccessPolicy }) {
  const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config, deepgramApiKey: 'key' }) }, {
    heartbeatIntervalMs: 50,
    isForwardedPort: () => true,
    ...(workspace && { workspace: { listenPort: 0, pathSecret: 'secret', access: workspace.access } }),
  });
  servers.push(server);
  await server.start();
  const prefix = workspace ? '/secret' : '';
  const port = server.getAddress()?.port ?? 0;
  const request = (method: string, url: string, token: string, body?: JsonValue, headers: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; body: JsonValue }>((resolve, reject) => {
    const sent = http.request({ host: '127.0.0.1', port, path: prefix + url, method, headers: { authorization: `Bearer ${token}`, ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += String(chunk); });
      response.on('end', () => {
        let parsed: JsonValue = text;
        try { parsed = decodeBoundary(JSON.parse(text), boundary.json); } catch { /* not JSON */ }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    sent.on('error', reject);
    sent.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return {
    server,
    request,
    invoke: (channel: string, token = 'pane_read_token', args: JsonValue[] = [], headers?: http.OutgoingHttpHeaders) => request('POST', '/invoke', token, { channel, args }, headers),
    /** Opens an event stream and collects what it receives. */
    stream: (token = 'pane_read_token', headers: http.OutgoingHttpHeaders = {}) => new Promise<{ text: () => string; ended: Promise<void>; close: () => void }>((resolve, reject) => {
      const sent = http.request({ host: '127.0.0.1', port, path: `${prefix}/events`, headers: { authorization: `Bearer ${token}`, ...headers } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += String(chunk); });
        resolve({ text: () => text, ended: new Promise((done) => { response.once('close', () => done()); }), close: () => sent.destroy() });
      });
      sent.on('error', reject);
      sent.end();
    }),
    upgrade: (url: string, token = 'pane_read_token') => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${prefix}${url}`, { headers: { authorization: `Bearer ${token}` } });
      socket.on('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); });
      socket.on('open', () => { resolve(101); socket.terminate(); });
      socket.on('error', reject);
    }),
  };
}

describe('a device paired Read only', () => {
  it('runs only the reviewed reads, of every command the host names and one added later', async () => {
    const registry = new PaneCommandRegistry();
    const ran: string[] = [];
    const channels = [...namedInSource(isDaemonOwnedChannel), 'sessions:added-tomorrow', 'runpane:browser:fill-secret', 'runpane:links:create'];
    for (const channel of channels) registry.register(channel, () => { ran.push(channel); return { success: true }; });
    expect(channels.length).toBeGreaterThan(400);
    const { invoke } = await serve(registry);

    const refused: string[] = [];
    for (const channel of channels) {
      const { status, body } = await invoke(channel);
      if (status === 409) {
        expect(body, channel).toMatchObject({ ok: false, error: { code: 'ERR_READ_ONLY_ACCESS', next: expect.stringContaining('full access') } });
        refused.push(channel);
      } else expect(status, channel).toBe(200);
    }

    expect([...ran].sort()).toEqual([...READABLE].sort());
    expect(channels.filter((channel) => !refused.includes(channel) && !ran.includes(channel)).sort()).toEqual([...ANSWERED].sort());
    // Links that start agents, terminals, approvals, secrets, files and machine commands are named here so none slips into the list above.
    expect(refused).toEqual(expect.arrayContaining(['runpane:links:open', 'runpane:panes:create', 'terminal:input', 'permission:respond', 'notify:remote-command', 'credentials:shared:get', 'secrets:lease:push', 'file:read', 'runpane:machine:exec', 'runpane:glasses:pair', 'ports:phone-address', 'relay:client:preview-address', 'runpane:browser:fill-secret']));
  }, 60_000);

  it('reaches no media, port, voice or preview route', async () => {
    const { request, upgrade } = await serve(new PaneCommandRegistry());
    expect(await request('GET', '/media?sessionId=s&filePath=a.png', 'pane_read_token')).toMatchObject({ status: 403, body: { error: { code: 'ERR_READ_ONLY_ACCESS' } } });
    expect(await upgrade('/ports/3000')).toBe(403);
    expect(await upgrade('/voice/deepgram-stream')).toBe(403);
  });

  it('leaves out settings, launch commands, what waits on the owner, and file, diff and browser tabs', async () => {
    const registry = new PaneCommandRegistry();
    const project = { id: 1, name: 'app', path: '/app', system_prompt: 'private', run_script: 'KEY=abc npm start', sessions: [{ id: 'pane' }] };
    const secret = 'API_KEY=hidden';
    // Records as Pane saves them.
    const terminal: TerminalPanelState = {
      isInitialized: true, cwd: '/app', agentType: 'claude', isCliPanel: true, initialCommand: `${secret} claude`, launchCommand: `${secret} claude`, initialInput: secret,
      initialInputFile: `/tmp/${secret}`, environmentVars: { KEY: secret }, orchestrationProfile: secret, selectionText: secret,
    };
    const chat: ChatPanelState = { agent: 'claude', cwd: '/app', status: 'idle', launch: { kind: 'profile', profile: secret }, initialInput: secret, settings: { mode: secret }, queue: [{ operationId: 'o', text: secret, queuedAt: '2026-11-25' }] };
    const panels = [
      { id: 't', type: 'terminal', state: { customState: terminal } },
      { id: 'c', type: 'chat', state: { customState: chat } },
      { id: 'e', type: 'explorer', state: { customState: { content: 'file text' } } },
      { id: 'b', type: 'browser' },
    ];
    const shown = [
      { id: 't', type: 'terminal', state: { customState: { isInitialized: true, cwd: '/app', agentType: 'claude', isCliPanel: true } } },
      { id: 'c', type: 'chat', state: { customState: { agent: 'claude', cwd: '/app', status: 'idle' } } },
    ];
    const closed = { panelId: 'gone' };
    registry.register('sessions:get-all-with-projects', () => ({ success: true, data: [project] }));
    registry.register('panels:list', () => ({ success: true, data: panels }));
    registry.register('runpane:panels:list', () => ({ ok: true, panels }));
    registry.register('panels:getActive', () => panels[2]);
    registry.register('orchestration-sessions:overview', () => ({ success: true, data: { session: { name: 'Ship', profile: secret, launchCommand: secret, customResume: { command: secret } }, panes: [{ panels: [...panels, closed] }] } }));
    registry.register('loops:list', () => ({ success: true, data: [{ id: 'l', name: 'Nightly', prompt: 'report', initialInput: secret, toolCommand: `${secret} ./report.sh` }] }));
    registry.register('chat-tab:get', () => ({ panelId: 'c', permissions: [{ toolCall: 'diff' }], questions: [{}], queue: [{}], messageCount: 2 }));
    const { invoke, stream, server } = await serve(registry);

    expect((await invoke('sessions:get-all-with-projects')).body).toEqual({ ok: true, result: { success: true, data: [{ id: 1, name: 'app', path: '/app', sessions: [{ id: 'pane' }] }] } });
    expect((await invoke('panels:list')).body).toEqual({ ok: true, result: { success: true, data: shown } });
    expect((await invoke('runpane:panels:list')).body).toEqual({ ok: true, result: { ok: true, panels: shown } });
    expect((await invoke('orchestration-sessions:overview')).body).toEqual({ ok: true, result: { success: true, data: { session: { name: 'Ship' }, panes: [{ panels: [...shown, closed] }] } } });
    expect((await invoke('loops:list')).body).toEqual({ ok: true, result: { success: true, data: [{ id: 'l', name: 'Nightly', prompt: 'report' }] } });
    expect((await invoke('chat-tab:get')).body).toEqual({ ok: true, result: { panelId: 'c', permissions: [], questions: [], queue: [], messageCount: 2 } });
    expect((await invoke('panels:getActive')).body).toEqual({ ok: true, result: null });
    expect((await invoke('sessions:get-all-with-projects', 'owner-token')).body).toEqual({ ok: true, result: { success: true, data: [project] } });

    const reader = await stream();
    server.getEventSink().send('project:updated', project);
    server.getEventSink().send('panel:updated', panels[2]);
    server.getEventSink().send('panel:updated', panels[1]);
    server.getEventSink().send('panel:updated', panels[0]);
    await vi.waitFor(() => expect(reader.text()).toContain('"id":"t"'));
    expect(reader.text()).not.toMatch(/private|npm start|file text|hidden/u);
    reader.close();
  });

  it('receives only the reviewed events, of every event the host names and one added later', async () => {
    const { server, stream } = await serve(new PaneCommandRegistry());
    const reader = await stream();
    const owner = await stream('owner-token');
    const events = [...namedInSource(isPaneDaemonEventChannel), 'session:added-tomorrow'];
    for (const channel of events) server.getEventSink().send(channel, { type: channel === 'panel:event' ? 'terminal:exit' : 'terminal' });
    server.getEventSink().send('todos:changed', 'last');
    const received = (text: string) => [...new Set([...text.matchAll(/"channel":"([^"]+)"/gu)].map(([, channel]) => channel))].sort();
    await vi.waitFor(() => { for (const { text } of [reader, owner]) expect(text()).toContain('"last"'); });

    expect(received(reader.text())).toEqual([...READABLE_EVENTS].sort());
    expect(received(owner.text())).toEqual([...new Set(events)].sort());
    expect(server.hasEventSubscriber('permission:request')).toBe(true);
    owner.close();
    await vi.waitFor(() => expect(server.hasEventSubscriber('permission:request')).toBe(false));
    reader.close();
  });

  it('tells its reads they change nothing, and no one else', async () => {
    const registry = new PaneCommandRegistry();
    const seen: boolean[] = [];
    registry.register('orchestration-sessions:get', () => { seen.push(readOnlyPaneCaller()); return null; });
    const { invoke } = await serve(registry);
    await invoke('orchestration-sessions:get');
    await invoke('orchestration-sessions:get', 'owner-token');
    expect(seen).toEqual([true, false]);
  });

  it('stays read-only over Tailscale under the owner\'s own login, and loses its stream when removed', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('terminal:input', () => null);
    const config = readerConfig();
    const access = (): WorkspaceAccessPolicy => ({ ownerLogin: 'tyler@example.com', visibility: 'owner', tailnetLogins: new Set(), verifySecret: null });
    const { invoke, stream } = await serve(registry, config, { access });
    const owner = { 'tailscale-user-login': 'tyler@example.com' };
    expect((await invoke('terminal:input', 'pane_read_token', [], owner)).status).toBe(409);
    expect((await invoke('terminal:input', 'pane_read_token', [], { 'tailscale-user-login': 'parsa@example.com' })).status).toBe(409);
    expect((await invoke('terminal:input', 'owner-token', [], owner)).status).toBe(200);

    const reader = await stream('pane_read_token', { 'tailscale-user-login': 'parsa@example.com' });
    await vi.waitFor(() => expect(reader.text().match(/heartbeat/gu)?.length).toBeGreaterThan(2));
    config.host.clients = config.host.clients.filter((client) => client.id !== 'reader');
    await reader.ended;
  });

  it('waits, with a token another computer handed out, until that computer confirms it since this one woke', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('todos:snapshot', () => null);
    const config = readerConfig();
    config.host.clients[0].grantedBy = 'tyler';
    config.host.clients[0].linkedBy = 'Tyler';
    const { invoke, stream } = await serve(registry, config);
    expect(await invoke('todos:snapshot')).toMatchObject({ status: 503, body: { error: { code: 'ERR_READ_ONLY_UNCONFIRMED', message: expect.stringContaining('Tyler') } } });
    expect((await invoke('todos:snapshot', 'owner-token')).status).toBe(200);

    confirmedSharers.confirm('tyler');
    expect((await invoke('todos:snapshot')).status).toBe(200);
    const reader = await stream();
    // Asleep and awake again: closed until Tyler says so.
    confirmedSharers.clear();
    await reader.ended;
    expect((await invoke('todos:snapshot')).status).toBe(503);
  });
});
