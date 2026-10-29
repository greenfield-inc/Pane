import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteDaemonClient, type RemoteDaemonClientEvent } from '@shared/remoteClient';
import type { NotifySharedState } from '@shared/types/notify';
import type { ToolPanel } from '@shared/types/panels';
import type { RunpanePaneCreateResult } from '@shared/types/runpaneOrchestration';

import { decodeMachineList } from '@/auth/computers';
import { invokeChannel } from '@/daemon/invoke';
import type { ProjectWithPanes } from '@/features/panes/paneList';

import { DEMO_PROFILE, demoConnection, isDemoProfile, resetDemoHost } from './demoHost';

function connectDemo() {
  const client = new RemoteDaemonClient({
    profile: DEMO_PROFILE,
    ...demoConnection(),
    runtimeId: () => 'runtime-demo',
    clientLabel: 'Pane for iOS',
    staleStreamTimeoutMs: 20_000,
  });
  const events: RemoteDaemonClientEvent[] = [];
  client.onEvent(event => events.push(event));
  return { client, events };
}

async function connected(client: RemoteDaemonClient) {
  await client.connect();
  await vi.waitFor(() => expect(client.getState().status).toBe('connected'));
}

const channelEvents = (events: RemoteDaemonClientEvent[], channel: string) =>
  events.flatMap(event => (event.type === 'daemon-event' && event.payload.channel === channel ? [event.payload.args] : []));

describe('demo host', () => {
  beforeEach(() => {
    resetDemoHost();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('The demo must not use the network'); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('connects the real client without touching the network', async () => {
    const { client } = connectDemo();
    await connected(client);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('is recognised by its profile and never looks like a real host', () => {
    expect(isDemoProfile(DEMO_PROFILE)).toBe(true);
    expect(isDemoProfile({ baseUrl: 'https://studio-mac.tail1234.ts.net:8443' })).toBe(false);
    expect(isDemoProfile({ baseUrl: 'https://demo.invalid.example.com' })).toBe(false);
  });

  it('takes an answer to a waiting question, holds it for Undo, then passes it on', async () => {
    const { client, events } = connectDemo();
    await connected(client);
    const before = await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot');
    const question = before.items.find(item => item.state === 'waiting' && item.ui === 'options');
    expect(question?.choices?.length).toBeGreaterThan(1);
    if (!question?.choices) return;

    await invokeChannel(client, 'notify:remote-command', [{ type: 'answer', id: question.id, answer: { choice: question.choices[0].label } }]);
    const held = await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot');
    expect(held.items.find(item => item.id === question.id)?.state).toBe('sent');
    expect(channelEvents(events, 'notify:shared-changed').length).toBeGreaterThan(0);

    await vi.waitFor(async () => {
      const after = await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot');
      expect(after.items.find(item => item.id === question.id)).toMatchObject({ state: 'answered', answerSummary: question.choices?.[0].label });
      expect(after.revision).toBeGreaterThan(held.revision);
    }, { timeout: 5_000 });
    client.disconnect();
  });

  it('brings a question back when the answer is undone', async () => {
    const { client } = connectDemo();
    await connected(client);
    const snapshot = await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot');
    const question = snapshot.items.find(item => item.state === 'waiting' && item.ui === 'approve');
    if (!question) throw new Error('The demo has no approval question');
    await invokeChannel(client, 'notify:remote-command', [{ type: 'answer', id: question.id, answer: { approved: true } }]);
    await invokeChannel(client, 'notify:remote-command', [{ type: 'undo', id: question.id }]);
    const after = await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot');
    expect(after.items.find(item => item.id === question.id)?.state).toBe('waiting');
    client.disconnect();
  });

  it('creates a Pane that later reads list, with a terminal to open', async () => {
    const { client } = connectDemo();
    await connected(client);
    const created = await invokeChannel<RunpanePaneCreateResult>(client, 'runpane:panes:create', [
      { repo: { id: 1 }, panes: [{ name: 'try-the-demo', baseBranch: 'origin/main', pinned: false, tool: { agent: 'claude' } }] },
    ]);
    const [item] = created.items;
    if (!item?.ok || !('paneId' in item) || !item.paneId) throw new Error('No Pane created');
    const projects = await invokeChannel<ProjectWithPanes[]>(client, 'sessions:get-all-with-projects');
    expect(projects.flatMap(project => project.sessions ?? []).map(pane => pane.name)).toContain('try-the-demo');
    const panels = await invokeChannel<ToolPanel[]>(client, 'panels:list', [item.paneId]);
    expect(panels.map(panel => panel.title)).toEqual(['Claude Code', 'Terminal']);
    client.disconnect();
  });

  it('echoes what you type into a terminal and the agent answers', async () => {
    const { client, events } = connectDemo();
    await connected(client);
    const [agent] = await invokeChannel<ToolPanel[]>(client, 'panels:list', ['demo-copy-review']);
    await client.invoke('terminal:input', [agent.id, 'check the cart page\r']);
    const output = () => channelEvents(events, 'terminal:output').map(([payload]) => (payload as { output: string }).output).join('');
    expect(output()).toContain('check the cart page');
    await vi.waitFor(() => expect(output()).toContain('Working on it now'), { timeout: 3_000 });
    const state = await client.invoke<{ scrollbackBuffer: string }>('terminal:getState', [agent.id]);
    expect(state.scrollbackBuffer).toContain('check the cart page');
    client.disconnect();
  });

  it('answers every channel the signed-in screens read', async () => {
    const { client } = connectDemo();
    await connected(client);
    const reads: Array<[string, unknown[]]> = [
      ['sessions:get-all-with-projects', []], ['sessions:get-archived-with-projects', []], ['sessions:get', ['demo-dark-mode']],
      ['runpane:workspace:state', [{}]], ['permission:getPending', []], ['projects:list-branches', ['1']],
      ['orchestration-sessions:list', []], ['notify:remote-snapshot', []], ['remote:pwa-affordances', []],
      ['mobile:push-status', [{ platform: 'ios', installationId: 'demo' }]], ['runpane:glasses:list', []],
      ['panels:list', ['demo-dark-mode']], ['panels:getActive', ['demo-dark-mode']], ['panels:checkInitialized', ['demo-dark-mode-agent']],
      ['terminal:getState', ['demo-dark-mode-agent']], ['terminal:getScrollbackClean', ['demo-dark-mode-agent', 300]],
      ['agent-chat:get', ['demo-dark-mode-agent']],
    ];
    for (const [channel, args] of reads) await expect(invokeChannel(client, channel, args), channel).resolves.toBeDefined();
    const machines = decodeMachineList(await invokeChannel(client, 'runpane:workspaces:machines'));
    expect(machines.ok && machines.machines.map(machine => machine.state)).toEqual(['available', 'available', 'offline']);
    client.disconnect();
  });

  it('explains that uploads and voice need a real computer', async () => {
    const { client } = connectDemo();
    await connected(client);
    await expect(client.invoke('terminal:upload-start', [{ uploadId: 'u1', sessionId: 'demo-dark-mode', fileName: 'a.png', mimeType: 'image/png', size: 1, md5: '' }]))
      .rejects.toThrow(/your own computer/);
    await expect(invokeChannel(client, 'remote:settings:update', [{ deepgramApiKey: 'x' }])).rejects.toThrow(/your own computer/);
    client.disconnect();
  });

  it('still delivers an answer whose sample Pane was deleted', async () => {
    const { client } = connectDemo();
    await connected(client);
    await invokeChannel(client, 'sessions:delete', ['demo-dark-mode']);
    await invokeChannel(client, 'sessions:permanent-delete', ['demo-dark-mode']);
    await invokeChannel(client, 'notify:remote-command', [{ type: 'answer', id: 'demo-q-colors', answer: { choice: 'Design-system tokens' } }]);
    await vi.waitFor(async () => {
      const after = await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot');
      expect(after.items.find(item => item.id === 'demo-q-colors')?.state).toBe('answered');
    }, { timeout: 5_000 });
    client.disconnect();
  });

  it('gives a corrected answer its own Undo window', async () => {
    const { client } = connectDemo();
    await connected(client);
    const answer = (choice: string) => invokeChannel(client, 'notify:remote-command', [{ type: 'answer', id: 'demo-q-colors', answer: { choice } }]);
    const state = async () => (await invokeChannel<NotifySharedState>(client, 'notify:remote-snapshot')).items.find(item => item.id === 'demo-q-colors')?.state;
    await answer('New dark palette');
    await new Promise(resolve => setTimeout(resolve, 2_000));
    await invokeChannel(client, 'notify:remote-command', [{ type: 'undo', id: 'demo-q-colors' }]);
    await answer('Design-system tokens');
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(await state()).toBe('sent');
    client.disconnect();
  }, 10_000);
});
