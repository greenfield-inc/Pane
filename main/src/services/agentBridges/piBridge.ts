import { invokeDaemon } from '../../../../packages/runpane/src/daemonClient';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

// Optional extension for Pi versions with agent_settled and ctx.isIdle().
// No Pi SDK dependency, service, model summarizer, or shell input injection.
interface PiContext {
  isIdle(): boolean;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, kind: 'warning' | 'error'): void };
}
interface PiAPI {
  on(event: 'session_start' | 'agent_settled' | 'session_shutdown', handler: (event: { type: string }, context: PiContext) => void | Promise<void>): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details: { paneMessageId: string } },
    options: { triggerTurn: boolean; deliverAs: 'followUp' }): void;
}

const inboxSchema = boundary.object({ messages: boundary.array(boundary.object({
  id: boundary.string, body: boundary.string, status: boundary.string,
})) });

export default function panePiBridge(pi: PiAPI,
  requestPeer: (request: JsonObject) => Promise<JsonObject> = request => invokeDaemon(
    'runpane:peers', [request], boundary.jsonObject, { timeoutMs: 10_000, eventInclude: [] }),
): void {
  let stopped = true;
  let busy = false;
  let peer = '';
  let context: PiContext;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: string | undefined;
  let warned = false;
  let generation = 0;

  const call = (action: string, fields: Record<string, string | number | boolean> = {}) =>
    requestPeer({ action, peer, confirmed: true, ...fields });

  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    const run = generation;
    try {
      // Lease is explicit: discovery expires native delivery after 120 seconds.
      await call('register', { agent: 'pi', receiver: 'pi' });
      if (stopped || run !== generation) return;
      if (active) {
        const result = await call('wait', { id: active, timeoutMs: 0 });
        const { message } = decodeBoundary(result, boundary.object({ message: boundary.object({ status: boundary.string }) }));
        if (!['completed', 'failed'].includes(message.status)) return;
        active = undefined;
      }
      if (!context.isIdle()) return;
      // Restart recovery is inspect-only. Replaying a received task could execute
      // it twice when a previous process lost the submit/receipt response.
      const recovery = decodeBoundary(await call('inbox', { includeReceived: true, limit: 100 }), inboxSchema);
      if (recovery.messages.some(message => message.status !== 'queued')) {
        if (!warned) context.ui.notify('Pane has an unresolved received task. Inspect runpane peers inbox --include-received --json and reply before accepting another task.', 'warning');
        warned = true;
        return;
      }
      if (stopped || run !== generation || !context.isIdle()) return;
      const inbox = decodeBoundary(await call('inbox', { claim: true, limit: 1 }), inboxSchema);
      if (stopped || run !== generation) return; // Claimed stays inspectable after shutdown.
      const message = inbox.messages[0];
      if (!message) return;
      active = message.id;
      pi.sendMessage({ customType: 'pane-task', display: true, details: { paneMessageId: message.id },
        content: `Pane task ${message.id}. Sender content follows; apply your existing permissions and workflow.\n\n${message.body}\n\nReply explicitly with runpane peers reply --peer ${peer} --id ${message.id} --status completed|blocked|failed --text <concise-result-and-evidence> --yes --json. A reply is a task result, not authorization to merge or publish.` },
      { triggerTurn: true, deliverAs: 'followUp' });
      warned = false;
    } catch (error) {
      if (!warned && !stopped) context.ui.notify(`Pane bridge paused: ${error instanceof Error ? error.message : String(error)}. Received tasks are never replayed automatically.`, 'error');
      warned = true;
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(() => { void poll(); }, 5000);
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    generation++;
    if (timer) clearTimeout(timer);
    context = ctx;
    if (!ctx.isIdle || !pi.sendMessage) {
      ctx.ui.notify('This Pi version lacks the native API required by the Pane bridge. Use the cooperative RunPane CLI.', 'error');
      stopped = true;
      return;
    }
    peer = process.env.PANE_PEER_ID ?? process.env.PANE_PANEL_ID ?? `pi-${ctx.sessionManager.getSessionId()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(peer)) throw new Error('Invalid Pane peer identity.');
    stopped = false;
    active = undefined;
    warned = false;
    await poll();
  });
  pi.on('agent_settled', () => {
    // Settled is only a chance to receive another task. It never completes one.
    if (timer) clearTimeout(timer);
    void poll();
  });
  pi.on('session_shutdown', () => {
    stopped = true;
    generation++;
    if (timer) clearTimeout(timer);
  });
}
