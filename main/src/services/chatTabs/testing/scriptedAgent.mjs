/* global process, setTimeout */
// A scripted ACP agent for chat tab tests. It never calls a model: each prompt's
// first word picks a behaviour. Conversations persist in SCRIPTED_AGENT_STORE so a
// new process can load (replay) them, as claude-agent-acp and codex-acp do.
//
//   <anything>          streams "You said: <text>" in chunks after a completed read step
//   permission          asks to run a command; replies with the chosen option
//   question            asks a form question (elicitation); replies with the answer
//   slow                streams until cancelled, then stops with stopReason "cancelled"
//   crash               exits the process mid-turn
//   signout             fails the turn with ACP authRequired (sign-in expired mid-conversation)
//   plan                sends a todo list (plan update)
//   edit                a completed edit step with a diff
//   env NAME [NAME...]  replies with those environment variables as JSON
//   caps                replies with the client capabilities, session _meta and mode
//   steps N             N completed steps of mixed kinds, then a reply
//   [Pane · Start]      Autopilot's Start: reads `runpane autopilot waiting --json`, puts the
//                       topmost Session's items on the stack, and lists them in an
//                       autopilot-items block (the real CLI, through the daemon)
//   approve it          Autopilot told to approve: says where the buttons are, as the skill says
//   usage               reports context usage (usage_update 1234 of 200000), then replies
//   task [quick]        starts a background shell (an async task) and replies; it runs until stopped
//                       with _session/async_task/stop, or with "quick" ends by itself shortly after
//   background          replies, then runs a turn of its own with no prompt open (as Claude does for a
//                       finished background task), announced as an async task to a client that takes them
//
// SCRIPTED_AGENT_SIGNED_OUT=1 refuses every session with ACP authRequired; SCRIPTED_AGENT_LIST_FAILS=1 refuses session/list.
import { agent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const store = process.env.SCRIPTED_AGENT_STORE ?? path.join(process.cwd(), '.scripted-agent');
mkdirSync(store, { recursive: true });
const file = id => path.join(store, `${id}.json`);
const sessions = new Map();
/** Background tasks still running, by id: the session they belong to. Never persisted, as a real adapter's are not. */
const liveTasks = new Map();
let clientCapabilities = {};

/** A turn the agent starts by itself: it works on after the prompt ended, like claude-agent-acp's autonomous turn. */
async function ownTurn(session, send) {
  const announced = clientCapabilities._meta?.jetbrains?.air?.capabilities?.includes('asyncTasks');
  const asyncTaskId = `autonomous-turn-${randomUUID()}`;
  await new Promise(resolve => setTimeout(resolve, 40));
  if (announced) await send({ sessionUpdate: 'async_task_spawned', asyncTaskId, name: 'Claude is working', taskType: 'turn', description: 'A background task finished.', showInTranscript: false, canStop: true });
  for (const title of ['Own step 1', 'Own step 2', 'Own step 3']) {
    if (session.ownTurnStopped) break;
    const toolCallId = `tool-${randomUUID()}`;
    await send({ sessionUpdate: 'tool_call', toolCallId, title, kind: 'read', status: 'in_progress' });
    await new Promise(resolve => setTimeout(resolve, 120));
    await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
  }
  if (announced) await send({ sessionUpdate: 'async_task_state_update', asyncTaskId, state: session.ownTurnStopped ? 'stopped' : 'completed' });
}

function persist(id) { writeFileSync(file(id), JSON.stringify(sessions.get(id))); }
function configOptions(session) {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.config.model, options: [{ value: 'default', name: 'Default' }, { value: 'fast', name: 'Fast' }] },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.config.mode, options: [{ value: 'default', name: 'Ask' }, { value: 'plan', name: 'Plan' }, { value: 'bypassPermissions', name: 'Bypass' }] },
  ];
}

const app = agent()
  .onRequest(methods.agent.initialize, ({ params }) => {
    clientCapabilities = params.clientCapabilities ?? {};
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { close: {}, list: {} } } };
  })
  .onRequest(methods.agent.session.new, async ({ params, client }) => {
    if (process.env.SCRIPTED_AGENT_SIGNED_OUT === '1') throw RequestError.authRequired();
    const id = `scripted-${randomUUID()}`;
    sessions.set(id, { cwd: params.cwd, updates: [], config: { model: 'default', mode: 'default' }, meta: params._meta ?? null });
    persist(id);
    setTimeout(() => void commands(client, id), 0);
    return { sessionId: id, configOptions: configOptions(sessions.get(id)) };
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    if (process.env.SCRIPTED_AGENT_SIGNED_OUT === '1') throw RequestError.authRequired();
    // A live adapter that never answers the load.
    if (process.env.SCRIPTED_AGENT_HANG_LOAD === '1') return new Promise(() => {});
    if (!existsSync(file(params.sessionId))) throw RequestError.resourceNotFound(params.sessionId);
    const session = JSON.parse(readFileSync(file(params.sessionId), 'utf8'));
    sessions.set(params.sessionId, session);
    for (const update of session.updates) await client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
    await commands(client, params.sessionId);
    return { configOptions: configOptions(session) };
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const session = sessions.get(params.sessionId);
    session.config[params.configId] = params.value;
    persist(params.sessionId);
    return { configOptions: configOptions(session) };
  })
  .onRequest(methods.agent.session.setMode, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    session.config.mode = params.modeId;
    persist(params.sessionId);
    // Like the real adapters, report the changed setting to the client.
    await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: configOptions(session) } });
    return {};
  })
  // Newest first, two to a page, so clients must follow the cursor. SCRIPTED_AGENT_LIST_FAILS=1 refuses (a signed-out Codex).
  .onRequest(methods.agent.session.list, ({ params }) => {
    if (process.env.SCRIPTED_AGENT_LIST_FAILS === '1') throw RequestError.internalError(undefined, 'not signed in');
    const all = readdirSync(store).filter(name => name.endsWith('.json')).flatMap(name => {
      const sessionId = name.slice(0, -'.json'.length);
      const saved = JSON.parse(readFileSync(file(sessionId), 'utf8'));
      if (params.cwd && saved.cwd !== params.cwd) return [];
      const first = saved.updates.find(update => update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text');
      return [{ sessionId, cwd: saved.cwd, title: first?.content.text.slice(0, 80) ?? null, updatedAt: statSync(file(sessionId)).mtime.toISOString() }];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const start = Number(params.cursor ?? 0);
    const page = all.slice(start, start + 2);
    return start + 2 < all.length ? { sessions: page, nextCursor: String(start + 2) } : { sessions: page };
  })
  .onRequest(methods.agent.session.close, () => ({}))
  .onRequest('_session/async_task/stop', { parse: value => value }, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (liveTasks.get(params.asyncTaskId) === params.sessionId && liveTasks.delete(params.asyncTaskId)) {
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'async_task_state_update', asyncTaskId: params.asyncTaskId, state: 'stopped' } });
      return { stopped: true };
    }
    if (session) session.ownTurnStopped = true;
    return { stopped: true };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => { const session = sessions.get(params.sessionId); if (session) session.cancelled = true; })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const id = params.sessionId;
    const session = sessions.get(id);
    session.cancelled = false;
    const text = params.prompt.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    const send = async update => { session.updates.push(update); persist(id); await client.notify(methods.client.session.update, { sessionId: id, update }); };
    // Each reply carries its own message id, as claude-agent-acp's live and replayed updates do.
    const say = async reply => { const messageId = randomUUID(); for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) await send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: chunk } }); };
    await send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    const [word, ...rest] = text.trim().split(/\s+/);
    if (word === 'signout') throw RequestError.authRequired();
    if (text.startsWith('[Pane · Start]') || text.startsWith('[Pane · Go on]')) {
      const runpane = (...args) => execFileSync('runpane', args, { encoding: 'utf8', env: process.env, timeout: 20_000 });
      const step = async (title, run) => {
        const toolCallId = `tool-${randomUUID()}`;
        await send({ sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'in_progress', rawInput: { command: title } });
        try { const output = run(); await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { stdout: output } }); return output; }
        catch (error) { await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { stderr: String(error?.stderr ?? error) } }); throw error; }
      };
      let items;
      try { items = JSON.parse(await step('runpane autopilot waiting --json', () => runpane('autopilot', 'waiting', '--json'))).items; }
      catch { await say('I could not read what waits: runpane autopilot waiting failed.'); return { stopReason: 'end_turn' }; }
      const local = items.filter(item => item.machineId === 'local');
      if (local.length === 0) { await say("Nothing waits on you now; I'll keep watching."); return { stopReason: 'end_turn' }; }
      const sessions = [...new Set(local.map(item => item.sessionName ?? 'Not in a Session'))];
      const top = local.filter(item => (item.sessionName ?? 'Not in a Session') === sessions[0]);
      for (const item of top) await step(`runpane autopilot stack push --item ${item.id} --json`, () => runpane('autopilot', 'stack', 'push', '--item', item.id, '--json'));
      await say(`**${local.length} ${local.length === 1 ? 'thing waits' : 'things wait'} on you** across ${sessions.length} ${sessions.length === 1 ? 'Session' : 'Sessions'}. Tap one to open it on the stack, or ask me about any of them.\n\n\`\`\`autopilot-items\n${local.map(item => item.id).join('\n')}\n\`\`\`\n`);
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('[Pane · Sentinel on]')) {
      await say(`I'll keep your Sessions moving while you're away. I answer only what a plan or decision already settles, nudge Sessions that stall, and send anything that needs you to your phone.\n\n\`\`\`autopilot-log\n{"at":"10:12","session":"Pane Fixes","kind":"answered","what":"Keep #1215's prompts? -> yes","why":"D-21 in the cover sheet"}\n\`\`\`\n`);
      return { stopReason: 'end_turn' };
    }
    if (text.startsWith('[Pane · Sentinel check]')) { await say('Checked in: nothing new.'); return { stopReason: 'end_turn' }; }
    if (text.startsWith('[Pane · Sentinel off]')) {
      await say(`\`\`\`autopilot-away\n{"summary":{"from":"09:58","to":"12:08"}}\n{"at":"10:12","session":"Pane Fixes","kind":"answered","what":"Keep #1215's prompts? -> yes","why":"D-21 in the cover sheet"}\n{"at":"10:38","session":"Infra","kind":"nudged","what":"orchestrator idle 25 min with a blocked report"}\n\`\`\`\n\nOne thing still needs you: the release question in Pane Fixes.`);
      return { stopReason: 'end_turn' };
    }
    if (/^approve it\b/i.test(text.trim())) {
      await say('Approvals are yours: the buttons are on the card, here in the chat.');
      return { stopReason: 'end_turn' };
    }
    if (word === 'crash') { await say('About to stop.'); process.exit(3); }
    if (word === 'slow') {
      while (!session.cancelled) { await say('.'); await new Promise(resolve => setTimeout(resolve, 30)); }
      return { stopReason: 'cancelled' };
    }
    if (word === 'permission') {
      const toolCallId = `tool-${randomUUID()}`;
      await send({ sessionUpdate: 'tool_call', toolCallId, title: 'Run `echo hi`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } });
      const answer = await client.request(methods.client.session.requestPermission, { sessionId: id, toolCall: { toolCallId, title: 'Run `echo hi`', kind: 'execute' }, options: [
        { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
        { optionId: 'always', name: "Yes, and don't ask again for echo commands", kind: 'allow_always' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ] });
      const chosen = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
      if (chosen === 'cancelled') { await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' }); return { stopReason: 'cancelled' }; }
      await send({ sessionUpdate: 'tool_call_update', toolCallId, status: chosen === 'reject' ? 'failed' : 'completed', rawOutput: chosen === 'reject' ? undefined : { stdout: 'hi\n' } });
      await say(`Permission: ${chosen}`);
      return { stopReason: 'end_turn' };
    }
    if (word === 'question') {
      const toolCallId = `tool-${randomUUID()}`;
      await send({ sessionUpdate: 'tool_call', toolCallId, title: 'AskUserQuestion', kind: 'other', status: 'pending' });
      const response = await client.request(methods.client.elicitation.create, { sessionId: id, mode: 'form', message: 'Which colour?', toolCallId, requestedSchema: { type: 'object', properties: { question_0: { type: 'string', title: 'Which colour?', oneOf: [{ const: 'Red', title: 'Red' }, { const: 'Blue', title: 'Blue' }] } } } });
      await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
      await say(`Answer: ${JSON.stringify(response)}`);
      return { stopReason: 'end_turn' };
    }
    if (word === 'plan') {
      await send({ sessionUpdate: 'plan', entries: [{ content: 'Read the code', priority: 'high', status: 'completed' }, { content: 'Write the fix', priority: 'high', status: 'in_progress' }] });
      await say('Planned.');
      return { stopReason: 'end_turn' };
    }
    if (word === 'edit') {
      const toolCallId = `tool-${randomUUID()}`;
      await send({ sessionUpdate: 'tool_call', toolCallId, title: 'Edit notes.txt', kind: 'edit', status: 'in_progress', locations: [{ path: path.join(session.cwd, 'notes.txt') }] });
      await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'diff', path: path.join(session.cwd, 'notes.txt'), oldText: 'a\n', newText: 'b\n' }] });
      await say('Edited.');
      return { stopReason: 'end_turn' };
    }
    if (word === 'usage') {
      await client.notify(methods.client.session.update, { sessionId: id, update: { sessionUpdate: 'usage_update', used: 1234, size: 200000 } });
      await say('Counted.');
      return { stopReason: 'end_turn' };
    }
    if (word === 'task') {
      const asyncTaskId = `task-${randomUUID()}`;
      liveTasks.set(asyncTaskId, id);
      const notify = update => client.notify(methods.client.session.update, { sessionId: id, update });
      await notify({ sessionUpdate: 'async_task_spawned', asyncTaskId, name: 'Shell', taskType: 'bash', description: 'npm run watch', showInTranscript: true, canStop: true });
      if (rest[0] === 'quick') setTimeout(() => { if (liveTasks.delete(asyncTaskId)) void notify({ sessionUpdate: 'async_task_state_update', asyncTaskId, state: 'completed' }); }, 150);
      await say('Started a task.');
      return { stopReason: 'end_turn' };
    }
    if (word === 'background') {
      void ownTurn(session, send);
      await say('Started it.');
      return { stopReason: 'end_turn' };
    }
    if (word === 'env') { await say(JSON.stringify(Object.fromEntries(rest.map(name => [name, process.env[name] ?? null])))); return { stopReason: 'end_turn' }; }
    if (word === 'caps') { await say(JSON.stringify({ clientCapabilities, meta: session.meta, mode: session.config.mode })); return { stopReason: 'end_turn' }; }
    if (word === 'steps') {
      const kinds = ['read', 'search', 'execute', 'edit'];
      for (let index = 0; index < Number(rest[0] ?? 3); index++) {
        const toolCallId = `tool-${randomUUID()}`;
        await send({ sessionUpdate: 'tool_call', toolCallId, title: `Step ${index + 1}`, kind: kinds[index % kinds.length], status: 'in_progress' });
        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
      }
      await say('Done.');
      return { stopReason: 'end_turn' };
    }
    const toolCallId = `tool-${randomUUID()}`;
    await send({ sessionUpdate: 'tool_call', toolCallId, title: 'Read README.md', kind: 'read', status: 'completed' });
    await say(`You said: ${text}`);
    return { stopReason: 'end_turn' };
  });

async function commands(client, sessionId) {
  await client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the conversation' }, { name: 'review', description: 'Review changes', input: { hint: 'what to review' } }] } });
}

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
process.exit(0);
