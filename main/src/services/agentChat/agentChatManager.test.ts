import { randomUUID } from 'crypto';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../../core/runtime';
import { databaseService } from '../database';
import { panelManager } from '../panelManager';
import { AgentChatManager } from './agentChatManager';
import type { TerminalPanelState } from '../../../../shared/types/panels';

beforeEach(async () => {
  const config = new ConfigManager();
  await config.updateConfig({ defaultAgentInterface: 'terminal' });
  setPaneRuntime({ eventSink: { send: vi.fn() }, getConfigManager: () => config, getPtyHostRuntime: () => null, getWebviewContextMap: () => new Map() });
});
afterEach(() => { resetPaneRuntimeForTests(); vi.unstubAllEnvs(); });

describe('agent chat host commands', () => {
  it('keeps an unregistered terminal usable without inventing ownership', async () => {
    const id = randomUUID();
    databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
    const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', title: 'Codex', initialState: { customState: { agentType: 'codex', initialCommand: 'codex --yolo' } } });
    const manager = new AgentChatManager();
    expect(manager.view(panel.id)).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/verified conversation connection/i) });
    expect(() => manager.guardNativeInput(panel.id, 'hello')).not.toThrow();
    await expect(manager.switchTo(panel.id, 'chat', 0)).rejects.toMatchObject({ code: 'CHAT_PROFILE_UNSUPPORTED' });
    // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
    expect((panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState).agentChat).toBeUndefined();
  });
});

// These fixtures use a POSIX fake CLI. Actual Windows processes have separate runtime QA.
it.skipIf(process.platform === 'win32')('keeps a native conversation usable when automatic adapter setup fails and persists the checkpoint identity', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const { recordNativeHook } = await import('./nativeHookJournal');
  const directory = mkdtempSync(join(tmpdir(), 'pane-native-launch-'));
  const executable = join(directory, 'claude');
  writeFileSync(executable, '#!/bin/sh\necho "2.1.309 (Claude Code)"\n', { mode: 0o700 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exit = once(child, 'exit');
  await once(child, 'spawn');
  const id = randomUUID();
  const nativeId = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'claude', initialCommand: executable, agentSessionId: nativeId } });
  const manager = new AgentChatManager({ enabled: () => true });
  const { getPaneEventSink } = await import('../../core/runtime');
  const events = vi.spyOn(getPaneEventSink(), 'send');
  try {
    manager.attachNative({ pid: () => child.pid, writeControl: () => undefined, destroy: async () => undefined, initialize: async () => undefined });
    const command = await manager.prepareNativeLaunch(panel, directory, process.env, `${executable} --session-id ${nativeId}`, 'bash', false);
    expect(command).toContain('--settings');
    // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
    const saved = (panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState).agentChat!;
    expect(saved.conversation).toMatchObject({ active: 'terminal', nativeSessionId: nativeId, generation: 1 });
    recordNativeHook(saved.launch.journalFile, { session_id: nativeId, hook_event_name: 'SessionStart', cwd: directory, source: 'startup' });
    recordNativeHook(saved.launch.journalFile, { session_id: nativeId, hook_event_name: 'Stop', permission_mode: 'default', background_tasks: [], session_crons: [] });
    await expect.poll(() => events.mock.calls.some(([channel, payload]) => channel === 'agent-chat:state' && decodeOptionalBoundary(payload, boundary.object({ running: boundary.boolean }))?.running === false)).toBe(true);
    expect(manager.view(panel.id)).toMatchObject({ available: true, setupRequired: true });
    vi.stubEnv('npm_config_registry', 'http://127.0.0.1:1');
    vi.stubEnv('npm_config_fetch_retries', '0');
    await expect(manager.switchTo(panel.id, 'chat', 1)).rejects.toMatchObject({ code: 'CHAT_ADAPTER_INSTALL_FAILED' });
    expect(manager.view(panel.id).conversation?.active).toBe('terminal');
    expect(() => manager.guardNativeInput(panel.id, 'New prompt\r')).not.toThrow();
    events.mockClear();
    await expect.poll(() => events.mock.calls.some(([channel, payload]) => channel === 'agent-chat:state' && decodeOptionalBoundary(payload, boundary.object({ running: boundary.boolean }))?.running === true)).toBe(true);
  } finally { events.mockRestore(); child.kill(); await exit; manager.detachObservers(); rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('switches one exact conversation through native, ACP and native while all viewers share the durable generation', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const { recordNativeHook } = await import('./nativeHookJournal');
  const { CLAUDE_ADAPTER_VERSION } = await import('./adapterSetup');
  const { getAppDirectory } = await import('../../utils/appDirectory');
  const adapter = join(getAppDirectory(), 'agent-adapters', `claude-${CLAUDE_ADAPTER_VERSION}`, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
  mkdirSync(join(adapter, 'dist'), { recursive: true });
  writeFileSync(join(adapter, 'package.json'), JSON.stringify({ version: CLAUDE_ADAPTER_VERSION }));
  writeFileSync(join(adapter, 'dist', 'index.js'), `let buffer='';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let mode='default', effort='medium';
const config = () => [{id:'mode',name:'Mode',type:'select',currentValue:mode,options:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}]},{id:'effort',name:'Effort',type:'select',currentValue:effort,options:[{value:'medium',name:'Medium'},{value:'high',name:'High'}]}];
process.stdin.on('data', chunk => { buffer += chunk; let end; while ((end=buffer.indexOf('\\n'))>=0) {
 const m=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1); if (m.id===undefined) continue;
 let result={}; if(m.method==='initialize') result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{},fork:{}}}};
 if(m.method==='session/fork') result={sessionId:'fork-native-a'};
 if(m.method==='session/load' && require('fs').existsSync('exact-load-fails')) { require('fs').unlinkSync('exact-load-fails');send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Exact import unavailable'}});continue; }
 if(m.method==='session/load') { send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'user_message_chunk',messageId:'history-a',content:{type:'text',text:'Preserved native history'}}}}); result={modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]},configOptions:config()}; }
 if(m.method==='session/new') result={sessionId:'fresh-native-a',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}};
 if(m.method==='session/prompt' && m.params.prompt[0]?.text==='Fail this turn') { send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Provider authentication expired'}}); continue; }
 if(m.method==='session/set_config_option') { if(m.params.configId==='mode')mode=m.params.value;if(m.params.configId==='effort')effort=m.params.value;result={configOptions:config()}; }
 if(m.method==='session/prompt') { send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:'new-answer',content:{type:'text',text:'Only one new answer'}}}}); result={stopReason:'end_turn'}; }
 send({jsonrpc:'2.0',id:m.id,result});
}}); process.stdin.on('end',()=>process.exit(0));`);
  const directory = mkdtempSync(join(tmpdir(), 'pane-native-handoff-'));
  const executable = join(directory, 'claude');
  writeFileSync(executable, '#!/bin/sh\necho "2.1.309 (Claude Code)"\n', { mode: 0o700 });
  let child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let exited = once(child, 'exit');
  await once(child, 'spawn');
  const id = randomUUID(), nativeId = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'claude', initialCommand: executable, agentSessionId: nativeId } });
  const manager = new AgentChatManager({ enabled: () => true });
  // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
  const state = () => (panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState).agentChat!;
  const hook = (name: string, extra = {}) => recordNativeHook(state().launch.journalFile, { session_id: state().conversation.nativeSessionId, hook_event_name: name, cwd: directory, ...extra });
  try {
    manager.attachNative({
      pid: () => child.pid,
      writeControl: (_panel, input) => { expect(input).toBe('/exit\r'); hook('SessionEnd'); child.kill(); },
      destroy: async () => { await exited; },
      initialize: async () => {
        expect(state().processes.chat).toEqual([]);
        expect(state().conversation.nativeStartup).toBe(true);
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        exited = once(child, 'exit');
        await once(child, 'spawn');
        const command = await manager.prepareNativeLaunch(panelManager.getPanel(panel.id)!, directory, process.env, `${executable} --resume ${nativeId}`, 'bash', false);
        expect(command).toContain(`'--resume' '${state().conversation.nativeSessionId}'`);
        hook('SessionStart', { source: 'resume' });
      },
    });
    await manager.prepareNativeLaunch(panel, directory, process.env, `${executable} --session-id ${nativeId}`, 'bash', false);
    hook('SessionStart', { source: 'startup' });
    hook('Stop', { permission_mode: 'default', background_tasks: [], session_crons: [] });
    await manager.switchTo(panel.id, 'chat', 1);
    const { getRuntimeConfigManager } = await import('../../core/runtime');
    expect(getRuntimeConfigManager().getConfig().defaultAgentInterface).toBe('chat');
    const firstViewer = manager.view(panel.id);
    const secondViewer = manager.view(panel.id);
    expect(firstViewer).toEqual(secondViewer);
    expect(firstViewer.conversation).toMatchObject({ active: 'chat', nativeSessionId: nativeId, generation: 2 });
    expect(firstViewer.transcript?.messages[0].parts).toEqual([{ type: 'text', text: 'Preserved native history' }]);
    expect(() => manager.guardNativeInput(panel.id, 'raw bytes')).toThrow(/raw terminal input/i);
    const request = { generation: 2, operationId: 'send-once', text: 'One follow-up' };
    const receipt = manager.send(panel.id, request);
    expect(manager.send(panel.id, request)).toEqual(receipt);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(manager.receipt(panel.id, request.operationId)?.state).toBe('completed');
    expect(manager.view(panel.id).transcript?.messages.filter(message => message.id === 'new-answer')).toHaveLength(1);
    expect(manager.view(panel.id).transcript?.messages.filter(message => message.role === 'user').map(message => message.parts)).toEqual([
      [{ type: 'text', text: 'Preserved native history' }], [{ type: 'text', text: 'One follow-up' }],
    ]);
    expect(() => manager.send(panel.id, { ...request, text: 'Changed retry' })).toThrow(/different content/i);

    const { getPaneEventSink } = await import('../../core/runtime');
    const statusSpy = vi.spyOn(getPaneEventSink(), 'send');
    manager.send(panel.id, { ...request, operationId: 'failed-turn', text: 'Fail this turn' });
    await expect.poll(() => manager.receipt(panel.id, 'failed-turn')?.state).toBe('failed');
    expect(manager.view(panel.id).error).toContain('Provider authentication expired');
    expect(manager.status(panel.id)).toBe('blocked');
    const { chatLastMessage, waitForChat } = await import('../../ipc/runpaneChat');
    const { agentChatManager } = await import('./agentChatManager');
    const viewSpy = vi.spyOn(agentChatManager, 'view').mockImplementation(() => manager.view(panel.id));
    try {
      expect(() => chatLastMessage(panel, 100)).toThrow(/authentication expired/);
      await expect(waitForChat(panel, { panelId: panel.id, condition: 'idle' })).rejects.toMatchObject({ code: 'CHAT_TURN_FAILED' });
    } finally { viewSpy.mockRestore(); }
    expect(statusSpy.mock.calls.filter(([channel]) => channel === 'panel:agentStatus').map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ state: 'working' }), expect.objectContaining({ state: 'blocked' }),
    ]);
    statusSpy.mockClear();
    manager.send(panel.id, { ...request, operationId: 'after-failure', text: 'Continue successfully' });
    await expect.poll(() => manager.receipt(panel.id, 'after-failure')?.state).toBe('completed');
    expect(manager.view(panel.id).error).toBeUndefined();
    expect(statusSpy.mock.calls.filter(([channel]) => channel === 'panel:agentStatus').map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ state: 'working' }), expect.objectContaining({ state: 'idle', workedVisibly: true }),
    ]);
    statusSpy.mockRestore();

    hook('Stop', { permission_mode: 'default', effort: { level: 'medium' }, background_tasks: [], session_crons: [] });
    await manager.configure(panel.id, 2, 'mode', 'plan');
    await manager.configure(panel.id, 2, 'effort', 'high');
    const { AcpSession } = await import('./acpSession');
    const brokenCancel = vi.spyOn(AcpSession.prototype, 'cancel').mockRejectedValue(new Error('Broken cancel write'));
    try { await manager.switchTo(panel.id, 'terminal', 2); } finally { brokenCancel.mockRestore(); }
    expect(getRuntimeConfigManager().getConfig().defaultAgentInterface).toBe('terminal');
    expect(state().launch).toMatchObject({ permissionMode: 'plan', effort: 'high' });
    expect(manager.view(panel.id).conversation).toMatchObject({ active: 'terminal', nativeSessionId: nativeId, generation: 3 });
    expect(manager.verifyNativeResume(panel.id, nativeId)).toEqual({ pid: child.pid });
    expect(() => manager.verifyNativeResume(panel.id, 'different-conversation')).toThrow(/exact saved conversation/);
    hook('Stop', { permission_mode: 'plan', effort: { level: 'high' }, background_tasks: [], session_crons: [] });
    writeFileSync(join(directory, 'exact-load-fails'), 'controlled exact import failure');
    await manager.switchTo(panel.id, 'chat', 3);
    expect(manager.view(panel.id).conversation).toMatchObject({ active: 'chat', nativeSessionId: 'fork-native-a', generation: 4 });
    expect(manager.view(panel.id).conversation?.transferNotice).toBeUndefined();
    await manager.switchTo(panel.id, 'terminal', 4);
    expect(manager.view(panel.id).conversation).toMatchObject({ active: 'terminal', nativeSessionId: 'fork-native-a', generation: 5 });
    const fresh = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'claude', initialCommand: executable, initialInput: 'Fresh first turn' } });
    expect(await manager.prepareFreshChat(fresh, directory, process.env, 'bash', false, 'chat')).toBe(true);
    expect(manager.view(fresh.id).conversation).toMatchObject({ active: 'chat', nativeSessionId: 'fresh-native-a', generation: 1 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(manager.view(fresh.id).transcript?.messages.filter(message => message.role === 'user')).toHaveLength(1);
    // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
    expect((panelManager.getPanel(fresh.id)!.state.customState as TerminalPanelState).initialInputSentAt).toBeTruthy();
    child.kill(); await exited;
    await manager.stop(fresh.id);

  } finally {
    child.kill(); await exited; manager.detachObservers();
    try { await manager.stop(panel.id); } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(adapter, { recursive: true, force: true });
    }
  }
});

it('restores saved native ownership as stopped without starting a replacement process', async () => {
  const id = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal' });
  panelManager.commitAgentChat(panel.id, {
    conversation: { panelId: panel.id, workspaceId: id, provider: 'claude', nativeSessionId: 'exact-saved-id', active: 'terminal', preferred: 'terminal', generation: 4 },
    launch: { command: 'claude', cwd: process.cwd(), shellType: 'bash', executable: 'claude', version: '2.1.309', strictMcpConfig: true, journalFile: '/unused', settingsFile: '/unused' },
    processes: { terminal: [], chat: [] },
  });
  const restarted = new AgentChatManager();
  expect(restarted.view(panel.id).conversation).toMatchObject({ active: 'stopped', nativeSessionId: 'exact-saved-id', generation: 4 });
  expect(() => restarted.guardNativeInput(panel.id, 'submit\r')).toThrow(/stopped/i);
  expect(() => restarted.assertNativeInitialize(panel.id)).toThrow(/already has a conversation owner/i);
});

it.skipIf(process.platform === 'win32')('shares one Codex owner between native and Chat and remembers the last selected interface', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const { getRuntimeConfigManager } = await import('../../core/runtime');
  const directory = mkdtempSync(join(tmpdir(), 'pane-codex-host-'));
  const executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex-cli test-capabilities');process.exit(0)}
const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});const crypto=require('crypto');const args=process.argv.slice(2);const digest=args[args.indexOf('--ws-token-sha256')+1];
const server=new WebSocketServer({port:0,host:'127.0.0.1',verifyClient:({req})=>crypto.createHash('sha256').update((req.headers.authorization||'').replace(/^Bearer /,'')).digest('hex')===digest});
server.on('listening',()=>process.stderr.write('listening on: ws://127.0.0.1:'+server.address().port+'\\n'));
server.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data);if(m.id===undefined)return;const send=value=>socket.send(JSON.stringify(value));let result={};if(m.method==='model/list')result={data:[]};if(m.method.startsWith('thread/'))result={thread:{id:'native-codex-thread',turns:[],historyMode:'legacy',status:{type:'idle'}},model:'gpt-test',reasoningEffort:'low',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'}};if(m.method==='turn/start'){if(m.params.input[0].text==='Disconnect fixture'){send({method:'turn/started',params:{threadId:'native-codex-thread',turn:{id:'interrupted-turn'}}});socket.close();return;}result={turn:{id:'new-turn',status:'inProgress'}};send({method:'item/completed',params:{threadId:'native-codex-thread',item:{id:'answer',type:'agentMessage',text:'Fresh response'}}});send({method:'turn/completed',params:{threadId:'native-codex-thread',turn:{id:'new-turn',status:'completed'}}});}send({id:m.id,result});}));`, { mode: 0o700 });
  const id = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', initialCommand: executable } });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit'); await once(child, 'spawn');
  const manager = new AgentChatManager({ enabled: () => true });
  manager.attachNative({ pid: () => child.pid, writeControl: () => { throw new Error('Switch must not interrupt the native view'); }, destroy: async () => { child.kill(); await exited; }, initialize: async () => { throw new Error('Switch must not restart the native view'); } });
  try {
    const env = { ...process.env };
    expect(await manager.prepareFreshChat(panel, directory, env, 'bash', false)).toBe(false);
    expect(manager.view(panel.id).conversation).toMatchObject({ provider: 'codex', active: 'terminal', nativeSessionId: 'native-codex-thread', generation: 1 });
    const command = await manager.prepareNativeLaunch(panel, directory, env, executable, 'bash', false);
    expect(command).toContain('native-codex-thread');
    expect(command).toContain('--remote');
    expect(command).not.toContain(env.PANE_CODEX_CHAT_TOKEN);
    expect(() => manager.verifyNativeResume(panel.id, 'native-codex-thread')).toThrow(/exact saved conversation/);
    await manager.switchTo(panel.id, 'chat', 1);
    expect(getRuntimeConfigManager().getConfig().defaultAgentInterface).toBe('chat');
    expect(() => manager.guardNativeInput(panel.id, 'hidden terminal input')).toThrow(/raw terminal input/i);
    manager.send(panel.id, { generation: 2, operationId: 'fresh', text: 'New request' });
    await expect.poll(() => manager.receipt(panel.id, 'fresh')?.state).toBe('completed');
    expect(manager.view(panel.id).transcript).toMatchObject({ generation: 2, messages: expect.arrayContaining([expect.objectContaining({ id: 'answer' })]) });
    const returning = manager.switchTo(panel.id, 'terminal', 2);
    await expect.poll(() => manager.view(panel.id).conversation?.nativeStartup).toBe(true);
    expect(manager.view(panel.id).conversation?.active).toBe('chat');
    expect(() => manager.guardNativeInput(panel.id, 'native startup input')).not.toThrow();
    const { WebSocket } = await import('ws');
    const endpoint = command.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(endpoint).toBeTruthy();
    const native = new WebSocket(endpoint!, { headers: { Authorization: `Bearer ${env.PANE_CODEX_CHAT_TOKEN}` } });
    await once(native, 'open');
    const attached = once(native, 'message');
    native.send(JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'native-codex-thread' } }));
    await attached;
    await returning;
    expect(manager.verifyNativeResume(panel.id, 'native-codex-thread')).toEqual({ pid: child.pid });
    expect(manager.view(panel.id).conversation).toMatchObject({ active: 'terminal', generation: 3, nativeSessionId: 'native-codex-thread' });
    expect(getRuntimeConfigManager().getConfig().defaultAgentInterface).toBe('terminal');
    expect(() => manager.guardNativeInput(panel.id, 'native input')).not.toThrow();
    await manager.switchTo(panel.id, 'chat', 3);
    manager.send(panel.id, { generation: 4, operationId: 'disconnect', text: 'Disconnect fixture' });
    await expect.poll(() => manager.view(panel.id).conversation?.active).toBe('stopped');
    await manager.recover(panel.id, 'chat', 4);
    expect(manager.view(panel.id).conversation).toMatchObject({ active: 'chat', generation: 5, nativeSessionId: 'native-codex-thread' });
    manager.send(panel.id, { generation: 5, operationId: 'after-recovery', text: 'Continue after reconnect' });
    await expect.poll(() => manager.receipt(panel.id, 'after-recovery')?.state).toBe('completed');
  } finally { await manager.stop(panel.id); child.kill(); await exited; manager.detachObservers(); rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32').each([false, true])('binds an identified legacy tab to its existing owner without replay; remote=%s', async remote => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const { WebSocketServer, WebSocket } = await import('ws');
  const { decodeBoundary } = await import('../../../../shared/validation/boundaryDecoder');
  const directory = mkdtempSync(join(tmpdir(), 'pane-codex-identify-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const { port } = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  const nativeId = randomUUID();
  const calls: string[] = [];
  server.on('connection', (socket, request) => {
    if (remote) expect(request.headers.authorization).toBe('Bearer fixture-only-secret');
    socket.on('message', data => {
    const message = JSON.parse(data.toString()); calls.push(message.method);
    if (message.id === undefined) return;
    const result = message.method === 'model/list' ? { data: [] } : message.method === 'thread/loaded/list' ? { data: [nativeId] } : message.method === 'initialize' ? {} : { thread: { id: nativeId, turns: [{ id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'old-answer', text: 'Native history' }] }] }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } };
    socket.send(JSON.stringify({ id: message.id, result }));
  }); });
  const executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}\nconst socket=require('net').connect({host:'127.0.0.1',port:${port}});process.stdin.pipe(socket).pipe(process.stdout);process.stdin.on('end',()=>socket.end());socket.on('close',()=>process.exit(0));`, { mode: 0o700 });
  let child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let exited = once(child, 'exit'); await once(child, 'spawn');
  const id = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const command = remote ? `${executable} --remote ws://127.0.0.1:${port} --remote-auth-token-env OWNED_FIXTURE_TOKEN` : executable;
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', initialCommand: command } });
  const manager = new AgentChatManager({ enabled: () => true });
  const originalPid = child.pid;
  const clients: InstanceType<typeof WebSocket>[] = [];
  manager.attachNative({ pid: () => child.exitCode === null && child.signalCode === null ? child.pid : undefined, writeControl: () => { throw new Error('Identification must never type into the native draft'); }, destroy: async () => { child.kill(); await exited; }, initialize: async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    exited = once(child, 'exit'); await once(child, 'spawn');
    const env: NodeJS.ProcessEnv = { ...process.env, OWNED_FIXTURE_TOKEN: 'fixture-only-secret' };
    await manager.prepareFreshChat(panelManager.getPanel(panel.id)!, directory, env, 'bash', false);
    const input = await manager.prepareNativeLaunch(panelManager.getPanel(panel.id)!, directory, env, command, 'bash', false);
    const { tokenizeShellCommand } = await import('../agents/agentIdentity');
    const args = tokenizeShellCommand(input)!;
    const native = new WebSocket(args[args.indexOf('--remote') + 1], { headers: { Authorization: `Bearer ${env.PANE_CODEX_CHAT_TOKEN}` } });
    clients.push(native); await once(native, 'open');
    native.send(JSON.stringify({ id: 99, method: 'thread/resume', params: { threadId: nativeId } }));
  } });
  try {
    expect(await manager.prepareNativeLaunch(panel, directory, { ...process.env, OWNED_FIXTURE_TOKEN: 'fixture-only-secret' }, command, 'bash', false)).toBe(command);
    expect(manager.view(panel.id).identificationRequired).toBe(true);
    await expect(manager.identify(panel.id, randomUUID(), remote ? '' : join(directory, 'owner.sock'))).rejects.toMatchObject({ code: 'CHAT_IDENTITY_UNAVAILABLE' });
    expect(manager.view(panel.id).identificationRequired).toBe(true);
    expect(await manager.identify(panel.id, nativeId, remote ? '' : join(directory, 'owner.sock'))).toMatchObject({ available: true, identificationRequired: false });
    await manager.switchTo(panel.id, 'chat', 1);
    expect(manager.view(panel.id)).toMatchObject({ available: true, conversation: { nativeSessionId: nativeId, active: 'chat', generation: 2 }, transcript: { messages: [{ id: 'old-answer' }] } });
    await manager.switchTo(panel.id, 'terminal', 2);
    expect(child.exitCode).toBeNull();
    expect(child.pid).not.toBe(originalPid);
    expect(manager.verifyNativeResume(panel.id, nativeId)).toEqual({ pid: child.pid });
    expect(calls).not.toContain('thread/start'); expect(calls).not.toContain('thread/fork'); expect(calls).not.toContain('turn/start');
    await manager.stop(panel.id);
    expect(server.address()).not.toBeNull();
  } finally {
    await manager.stop(panel.id); manager.detachObservers();
    for (const client of clients) client.terminate();
    if (child.exitCode === null) { child.kill(); await exited; }
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops an identified embedded Codex owner before copying native history into the same tab', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const directory = mkdtempSync(join(tmpdir(), 'pane-embedded-codex-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit'); await once(child, 'spawn');
  const nativeId = randomUUID(), forkId = randomUUID();
  const executable = join(directory, 'codex'), callsFile = join(directory, 'calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}
const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});const fs=require('fs');const server=new WebSocketServer({port:0,host:'127.0.0.1'});
server.on('listening',()=>process.stderr.write('listening on: ws://127.0.0.1:'+server.address().port+'\\n'));
server.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data);if(m.id===undefined)return;fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(m)+'\\n');let result={};
if(m.method==='model/list')result={data:[]};
if(m.method==='thread/fork'){let alive=false;try{process.kill(${child.pid},0);alive=true;}catch{}if(alive){socket.send(JSON.stringify({id:m.id,error:{message:'Original owner still alive'}}));return;}result={thread:{id:${JSON.stringify(forkId)},turns:[{id:'old-turn',status:'completed',items:[{id:'historical-answer',type:'agentMessage',text:'Retained native history'}]}]},approvalPolicy:'on-request',sandbox:{type:'readOnly'}};}
socket.send(JSON.stringify({id:m.id,result}));}));`, { mode: 0o700 });
  const id = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const command = `${executable} --no-daemon`;
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', initialCommand: command, agentSessionId: nativeId } });
  const manager = new AgentChatManager({ enabled: () => true });
  manager.attachNative({ pid: () => child.exitCode === null && child.signalCode === null ? child.pid : undefined, writeControl: () => {}, destroy: async () => { child.kill(); await exited; }, initialize: async () => { throw new Error('Identification must not create another terminal'); } });
  try {
    await manager.prepareNativeLaunch(panel, directory, process.env, command, 'bash', false);
    const view = await manager.identify(panel.id, nativeId, '');
    expect(view).toMatchObject({ available: true, identificationRequired: false, conversation: { panelId: panel.id, active: 'chat', nativeSessionId: forkId }, transcript: { messages: [expect.objectContaining({ id: 'historical-answer' })] } });
    expect(view.conversation?.transferNotice).toMatch(/in-progress output/i);
    const calls = readFileSync(callsFile, 'utf8');
    expect(calls).toContain('"deferGoalContinuation":true');
    expect(calls).not.toContain('turn/start');
  } finally {
    try { await manager.stop(panel.id); } finally { child.kill(); await exited; manager.detachObservers(); rmSync(directory, { recursive: true, force: true }); }
  }
});

it('keeps a named native Codex profile in its original Terminal instead of substituting default policy', async () => {
  const id = randomUUID(), nativeId = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
  const command = '/fixture/codex --profile locked-down';
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', initialCommand: command, agentSessionId: nativeId } });
  const manager = new AgentChatManager({ enabled: () => true });
  manager.attachNative({ pid: () => process.pid, writeControl: () => { throw new Error('Must not inject input'); }, destroy: async () => { throw new Error('Must not stop the original profile'); }, initialize: async () => { throw new Error('Must not replace the profile'); } });
  expect(await manager.prepareFreshChat(panel, process.cwd(), process.env, 'bash', false, 'chat')).toBe(false);
  expect(await manager.prepareNativeLaunch(panel, process.cwd(), process.env, command, 'bash', false)).toBe(command);
  expect(manager.view(panel.id)).toMatchObject({ available: false, identificationRequired: false, error: expect.stringContaining('named profile locked-down') });
  await expect(manager.identify(panel.id, nativeId, '')).rejects.toMatchObject({ code: 'CHAT_CODEX_PROFILE_UNSUPPORTED' });
  expect(manager.manages(panel.id)).toBe(false);
});

it('keeps the original embedded Terminal usable when identification setup cannot write its directory', async () => {
  const { createHash } = await import('crypto');
  const { mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { join } = await import('path');
  const { getAppDirectory } = await import('../../utils/appDirectory');
  const id = randomUUID(), nativeId = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
  const command = '/fixture/codex --no-daemon';
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', initialCommand: command } });
  const manager = new AgentChatManager({ enabled: () => true });
  const destroy = vi.fn(async () => {});
  manager.attachNative({ pid: () => process.pid, writeControl: () => {}, destroy, initialize: async () => {} });
  await manager.prepareNativeLaunch(panel, process.cwd(), process.env, command, 'bash', false);
  const parent = join(getAppDirectory(), 'agent-chat');
  mkdirSync(parent, { recursive: true });
  const blocked = join(parent, createHash('sha256').update(panel.id).digest('hex'));
  writeFileSync(blocked, 'A file blocks directory creation');
  try {
    await expect(manager.identify(panel.id, nativeId, '')).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(() => manager.guardNativeInput(panel.id, 'retained draft')).not.toThrow();
    expect(manager.manages(panel.id)).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    rmSync(blocked);
    const commit = vi.spyOn(panelManager, 'commitAgentChat').mockImplementationOnce(() => { throw new Error('State storage unavailable'); });
    try {
      await expect(manager.identify(panel.id, nativeId, '')).rejects.toThrow('State storage unavailable');
      expect(() => manager.guardNativeInput(panel.id, 'retry draft')).not.toThrow();
      expect(manager.manages(panel.id)).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally { commit.mockRestore(); }
  } finally { rmSync(blocked, { recursive: true, force: true }); manager.detachObservers(); }
});

it.each([false, true])('recovers a correlated borrowed turn without interrupt and settles its receipt; completionRace=%s', async completionRace => {
  const { WebSocketServer } = await import('ws');
  const { once } = await import('events');
  const { decodeBoundary } = await import('../../../../shared/validation/boundaryDecoder');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const { port } = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  const nativeId = randomUUID(), id = randomUUID();
  let clientId = '', input: unknown[] = [], visible = false, resumed = false;
  let sawStart: (() => void) | undefined;
  const started = new Promise<void>(resolve => { sawStart = resolve; });
  const calls: string[] = [];
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); if (message.id === undefined) return;
    calls.push(message.method);
    if (message.method === 'turn/start') { clientId = message.params.clientUserMessageId; input = message.params.input; sawStart?.(); return; }
    if (message.method === 'thread/resume' && visible) resumed = true;
    const result = message.method === 'model/list' ? { data: [] } : message.method === 'thread/loaded/list' ? { data: [nativeId] } : message.method.startsWith('thread/') ? { thread: { id: nativeId, turns: visible ? [{ id: 'recovered-turn', status: completionRace && resumed ? 'completed' : 'inProgress', items: [{ type: 'userMessage', id: 'native-message', clientId, content: input }] }] : [] } } : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
  const command = `/fixture/codex --remote ws://127.0.0.1:${port}`;
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', initialCommand: command } });
  const manager = new AgentChatManager({ enabled: () => true });
  const destroy = vi.fn(async () => {});
  manager.attachNative({ pid: () => process.pid, writeControl: () => {}, destroy, initialize: async () => { throw new Error('No native replacement needed to recover Chat'); } });
  try {
    await manager.prepareNativeLaunch(panel, process.cwd(), process.env, command, 'bash', false);
    await manager.identify(panel.id, nativeId, ''); await manager.switchTo(panel.id, 'chat', 1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    manager.send(panel.id, { operationId: 'lost-response', generation: 2, text: 'One owned request' });
    await started; await vi.advanceTimersByTimeAsync(30_001); vi.useRealTimers();
    expect(manager.view(panel.id).conversation?.active).toBe('stopped');
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 20));
    visible = true;
    await manager.recover(panel.id, 'chat', 2);
    expect(destroy).not.toHaveBeenCalled();
    expect(calls.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(calls).not.toContain('turn/interrupt');
    if (!completionRace) {
      expect(manager.view(panel.id).running).toBe(true);
      expect(() => manager.send(panel.id, { operationId: 'too-soon', generation: 3, text: 'Do not start' })).toThrow(/already working/i);
      for (const socket of server.clients) socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'recovered-turn', status: 'completed' } } }));
    }
    await expect.poll(() => manager.receipt(panel.id, 'lost-response')?.state).toBe('completed');
    expect(manager.view(panel.id).running).toBe(false);
  } finally { vi.useRealTimers(); await manager.stop(panel.id); manager.detachObservers(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
