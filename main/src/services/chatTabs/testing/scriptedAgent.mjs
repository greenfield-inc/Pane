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
//
// SCRIPTED_AGENT_SIGNED_OUT=1 refuses every session with ACP authRequired.
import { agent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const store = process.env.SCRIPTED_AGENT_STORE ?? path.join(process.cwd(), '.scripted-agent');
mkdirSync(store, { recursive: true });
const file = id => path.join(store, `${id}.json`);
const sessions = new Map();
let clientCapabilities = {};

function persist(id) { writeFileSync(file(id), JSON.stringify(sessions.get(id))); }
function configOptions(session) {
  return [
    { id: 'model', name: 'Model', type: 'select', currentValue: session.config.model, options: [{ value: 'default', name: 'Default' }, { value: 'fast', name: 'Fast' }] },
    { id: 'mode', name: 'Mode', type: 'select', currentValue: session.config.mode, options: [{ value: 'default', name: 'Ask' }, { value: 'plan', name: 'Plan' }, { value: 'bypassPermissions', name: 'Bypass' }] },
  ];
}

const app = agent()
  .onRequest(methods.agent.initialize, ({ params }) => {
    clientCapabilities = params.clientCapabilities ?? {};
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { close: {} } } };
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
  .onRequest(methods.agent.session.close, () => ({}))
  .onNotification(methods.agent.session.cancel, ({ params }) => { const session = sessions.get(params.sessionId); if (session) session.cancelled = true; })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const id = params.sessionId;
    const session = sessions.get(id);
    session.cancelled = false;
    const text = params.prompt.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    const send = async update => { session.updates.push(update); persist(id); await client.notify(methods.client.session.update, { sessionId: id, update }); };
    const say = async reply => { for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } }); };
    await send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    const [word, ...rest] = text.trim().split(/\s+/);
    if (word === 'signout') throw RequestError.authRequired();
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
