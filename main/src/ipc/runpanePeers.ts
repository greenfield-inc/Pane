import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getAppDirectory } from '../utils/appDirectory';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { WorkspaceStateReader } from '../services/workspaceStateReader';
import { AgentMailbox, mailboxId, type AgentMessage } from '../services/agentMailbox';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const requestSchema = boundary.object({
  action: boundary.enumeration('self', 'list', 'register', 'send', 'inbox', 'reply', 'wait', 'wake'),
  peer: boundary.optional(boundary.string), to: boundary.optional(boundary.string),
  id: boundary.optional(boundary.string), text: boundary.optional(boundary.string),
  agent: boundary.optional(boundary.string), receiver: boundary.optional(boundary.enumeration('cooperative', 'pi')),
  status: boundary.optional(boundary.enumeration('blocked', 'completed', 'failed')),
  claim: boundary.optional(boundary.boolean), includeReceived: boundary.optional(boundary.boolean),
  after: boundary.optional(boundary.number), timeoutMs: boundary.optional(boundary.number),
  limit: boundary.optional(boundary.number), confirmed: boundary.optional(boundary.boolean),
});

export function registerPeerHandlers(registry: PaneCommandRegistry,
  services: { agentMailbox?: AgentMailbox; databaseService: Pick<AppServices['databaseService'], 'getDb'> },
  workspace: Pick<WorkspaceStateReader, 'listManagedCliPanels'>,
  terminal: { isTerminalInitialized(panelId: string): boolean }): void {
  // Lazily open so doctor and unrelated commands also work during diagnostics.
  const mailbox = () => services.agentMailbox ??= new AgentMailbox(services.databaseService.getDb());
  const listPeers = () => {
    const registered = mailbox().peers();
    const panels = workspace.listManagedCliPanels();
    const peers = panels.map(panel => {
      const receiver = registered.find(peer => peer.id === panel.panelId);
      return {
        id: panel.panelId, paneId: panel.paneId, name: panel.panelTitle ?? panel.paneName,
        agent: receiver?.agent ?? panel.agentType ?? 'unknown',
        online: terminal.isTerminalInitialized(panel.panelId),
        state: panel.agentState, worktreePath: panel.worktreePath,
        receiver: receiver?.online ? receiver.receiver : null,
        capabilities: { mailbox: true, automaticDelivery: receiver?.online && receiver.receiver === 'pi', terminalFallback: true },
      };
    });
    const managed = new Set(panels.map(panel => panel.panelId));
    return [...peers, ...registered.filter(peer => !managed.has(peer.id)).map(peer => ({
      id: peer.id, agent: peer.agent, online: peer.online,
      receiver: peer.online ? peer.receiver : null,
      capabilities: { mailbox: true, automaticDelivery: peer.online && peer.receiver === 'pi', terminalFallback: false },
    }))];
  };

  registry.register('runpane:peers', async (value) => {
    const request = decodeBoundary(value, requestSchema);
    const protocol = { ok: true, protocolVersion: 1 };
    if (request.action === 'list') return { ...protocol, peers: listPeers() };
    if (request.action === 'self') return {
      ...protocol, peer: request.peer ? listPeers().find(peer => peer.id === request.peer) ?? null : null,
      identity: request.peer ?? null,
      identitySource: 'caller --peer, PANE_PEER_ID or PANE_PANEL_ID; local user trust boundary',
      commands: ['peers list', 'peers register', 'peers send', 'peers inbox', 'peers reply', 'peers wait', 'peers wake'],
      capabilities: { durableMailbox: true, correlatedReplies: true, quietWait: true, arbitraryAgentLabels: true },
      piExtensionPath: materializePiExtension(),
      nextCommand: request.peer ? 'runpane peers inbox --json' : 'runpane peers register --peer <stable-id> --agent-label <name> --yes --json',
    };
    const peer = mailboxId(request.peer);
    const mutates = ['register', 'send', 'reply', 'wake'].includes(request.action) || request.claim;
    if (mutates && !request.confirmed) throw new Error('This operation requires --yes.');
    if (request.action === 'register') {
      mailbox().register(peer, request.agent ?? 'custom', request.receiver);
      return { ...protocol, peer: listPeers().find(item => item.id === peer) };
    }
    if (!listPeers().some(item => item.id === peer)) throw new Error('Unknown peer identity; register it first with peers register.');
    const timeoutMs = request.timeoutMs ?? (request.action === 'wait' ? 60_000 : 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) throw new Error('timeout must be 0-120000 ms.');
    if (request.action === 'inbox') return {
      ...protocol, ...await mailbox().waitInbox(peer, request.claim ?? false, request.includeReceived ?? false, request.limit ?? 20, timeoutMs, request.id),
    };
    const id = mailboxId(request.id, 'message id');
    if (request.action === 'send') {
      const to = mailboxId(request.to, 'recipient');
      if (!listPeers().some(item => item.id === to)) throw new Error('Unknown recipient; use peers list or register the recipient.');
      const sent = mailbox().send(id, peer, to, request.text ?? '');
      return { ...protocol, duplicate: sent.duplicate, message: receipt(sent.message),
        delivery: 'queued; consumption requires a recipient receipt',
        nextCommand: `runpane peers wait --id ${id} --json` };
    }
    if (request.action === 'reply') {
      if (!request.status) throw new Error('reply requires --status blocked|completed|failed.');
      return { ...protocol, message: receipt(mailbox().reply(id, peer, request.status, request.text ?? '')) };
    }
    if (request.action === 'wait') {
      const result = await mailbox().wait(id, peer, request.after, timeoutMs);
      return { ...protocol, timedOut: result.timedOut, message: receipt(result.message) };
    }

    const message = mailbox().get(id);
    const panel = workspace.listManagedCliPanels().find(item => item.panelId === message.recipient);
    if (!panel || panel.agentState !== 'idle' || !terminal.isTerminalInitialized(panel.panelId)) {
      throw new Error('Terminal wake requires a live managed agent with observed idle state.');
    }
    const screen = decodeBoundary(await registry.invoke('runpane:panels:screen', [{ panelId: panel.panelId, limit: 40 }]), boundary.object({
      state: boundary.object({ isCliReady: boundary.optional(boundary.boolean) }),
      composer: boundary.object({ isPresent: boundary.boolean, hasUndeliveredText: boundary.boolean }),
    }));
    if (!screen.state.isCliReady || !screen.composer.isPresent || screen.composer.hasUndeliveredText) {
      throw new Error('Cannot establish an empty agent composer; inspect the terminal and deliver the inbox cue manually.');
    }
    mailbox().attemptWake(id, peer);
    try {
      await registry.invoke('runpane:panels:submit', [{ panelId: panel.panelId,
        input: `Pane task ${id} is queued. Run runpane peers inbox --peer ${message.recipient} --id ${id} --claim --limit 1 --yes --json, follow that task, and reply using its message id.` }]);
      return { ...protocol, message: receipt(mailbox().get(id)), delivery: 'terminal wake attempted; consumption unconfirmed' };
    } catch (error) {
      return { ...protocol, message: receipt(mailbox().get(id)), delivery: 'terminal wake outcome unknown; do not replay',
        error: error instanceof Error ? error.message : String(error) };
    }
  });
}

// External Node/Pi cannot read Electron's app.asar. Publish the bundled extension
// in the existing private Pane directory, atomically, only when requested.
function materializePiExtension(): string | null {
  const source = path.resolve(__dirname, '../../assets/pi-extension.mjs');
  if (!fs.existsSync(source)) return null;
  const directory = path.join(getAppDirectory(), 'bridges');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, 'pi-extension.mjs');
  const contents = fs.readFileSync(source);
  if (fs.existsSync(destination) && fs.readFileSync(destination).equals(contents)) return destination;
  const temporary = path.join(directory, `pi-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

function receipt(message: AgentMessage) {
  return { id: message.id, sender: message.sender, recipient: message.recipient,
    status: message.status, reply: message.reply, revision: message.revision,
    updatedAt: message.updatedAt, wake: message.wake };
}
