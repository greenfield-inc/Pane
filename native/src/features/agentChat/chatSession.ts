import {
  applyAgentChatEvent,
  type AgentChatClient,
  type AgentChatEvent,
  type AgentChatReceipt,
  type AgentChatSend,
  type AgentChatView,
} from '@shared/types/agentChat';
import type { ChatReadingPosition } from './readingPosition';

interface ChatSnapshot {
  view?: AgentChatView;
  error?: string;
  pendingDelivery?: AgentChatSend;
  delivering?: boolean;
  attachment?: NonNullable<AgentChatSend['images']>[number];
}

export type ChatTransport = Pick<AgentChatClient, 'get' | 'send' | 'receipt'>;

/** A phone's view of a host conversation. Leaving this view never stops its owner. */
export class ChatSession {
  private state: ChatSnapshot = {};
  private readonly listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private pendingEvents: AgentChatEvent[] = [];
  private stateRevision = 0;
  private detached = false;
  private transportRevision = 0;
  private loadedTransportRevision = -1;
  private confirmation?: () => void;
  private deliveryConversation?: string;
  readingPosition: ChatReadingPosition = { atBottom: true };

  constructor(readonly panelId: string, private transport: ChatTransport) {}

  rebind(transport: ChatTransport): void { this.transport = transport; this.transportRevision++; }

  snapshot = (): ChatSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.detached = false;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.detached = true;
        this.releaseTranscript();
      }
    };
  };

  private releaseTranscript(): void {
    if (this.state.view) this.state = { ...this.state, view: { ...this.state.view, transcript: undefined } };
    this.pendingEvents = [];
  }

  private publish(patch: Partial<ChatSnapshot>): void {
    this.state = { ...this.state, ...patch };
    if (this.detached) this.releaseTranscript();
    this.listeners.forEach(listener => listener());
  }

  setError(error?: string): void { this.publish({ error }); }
  setAttachment(attachment?: ChatSnapshot['attachment']): void { this.publish({ attachment }); }

  receiveState(view: AgentChatView): void {
    if (view.panelId !== this.panelId) return;
    const current = this.state.view;
    if ((view.conversation?.generation ?? 0) < (current?.conversation?.generation ?? 0)) return;
    this.stateRevision++;
    const transcript = view.transcript ?? (current?.transcript?.generation === view.conversation?.generation ? current?.transcript : undefined);
    this.publish({ view: { ...view, transcript } });
    if (!transcript && view.conversation?.active === 'chat') void this.refresh();
  }

  receiveEvent(event: AgentChatEvent): void {
    if (event.panelId !== this.panelId) return;
    const transcript = this.state.view?.transcript;
    if (this.loading || !transcript) {
      // Overflow deliberately leaves a gap; the next snapshot repairs it.
      this.pendingEvents = this.pendingEvents.length < 1000 ? [...this.pendingEvents, event] : [event];
    }
    if (!transcript) { void this.refresh(); return; }
    const applied = applyAgentChatEvent(transcript, event);
    if (applied.resync) { void this.refresh(); return; }
    this.publish({ view: { ...this.state.view!, transcript: applied.transcript } });
  }

  refresh(repairAttempt = 0): Promise<void> {
    if (this.loading) return this.loading;
    let repair = false;
    const startingRevision = this.stateRevision;
    const transportRevision = this.transportRevision;
    this.loading = this.transport.get(this.panelId).then(view => {
      if (transportRevision !== this.transportRevision) { repair = true; return; }
      let transcript = view.transcript;
      let gap = false;
      for (const event of this.pendingEvents) {
        if (!transcript) { gap = true; break; }
        const applied = applyAgentChatEvent(transcript, event);
        transcript = applied.transcript;
        gap ||= applied.resync;
      }
      this.pendingEvents = [];
      repair = gap && repairAttempt < 1;
      if ((view.conversation?.generation ?? 0) >= (this.state.view?.conversation?.generation ?? 0)) {
        this.loadedTransportRevision = transportRevision;
        const current = this.state.view;
        if (current?.transcript && transcript && current.transcript.generation === transcript.generation && current.transcript.revision > transcript.revision) transcript = current.transcript;
        const state = current && this.stateRevision > startingRevision && current.conversation?.generation === view.conversation?.generation ? current : view;
        this.publish({ view: { ...state, transcript }, error: gap ? 'The conversation changed while reconnecting. Refresh to load the latest messages.' : this.state.pendingDelivery ? this.state.error : undefined });
      } else if (this.state.view?.conversation?.active === 'chat' && !this.state.view.transcript) {
        // A handoff can finish while the older generation's request is in
        // flight. Its response cannot supply the new owner's history.
        repair = repairAttempt < 1;
      }
    }).catch(error => {
      if (transportRevision !== this.transportRevision) repair = true;
      else this.setError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      this.loading = undefined;
      if (repair && !this.detached) return this.refresh(repairAttempt + 1);
    });
    return this.loading;
  }

  async send(request: AgentChatSend, confirmed?: () => void): Promise<AgentChatReceipt | undefined> {
    if (this.state.pendingDelivery || this.state.delivering) return;
    const view = this.state.view;
    if (this.loadedTransportRevision !== this.transportRevision || view?.conversation?.active !== 'chat' || view.conversation.transition || view.running || view.permissions.length || request.generation !== view.conversation.generation) {
      this.setError('This conversation cannot accept a message yet. Refresh and wait for the current turn or switch to finish.');
      return;
    }
    this.confirmation = confirmed;
    this.deliveryConversation = view.conversation.nativeSessionId;
    this.publish({ pendingDelivery: request, error: undefined });
    return this.deliver(request);
  }

  private confirm(receipt: AgentChatReceipt, request: AgentChatSend): void {
    if (receipt.state !== 'failed') this.confirmation?.();
    this.confirmation = undefined;
    const attachment = receipt.state !== 'failed' && this.state.attachment === request.images?.[0] ? undefined : this.state.attachment;
    this.publish({ pendingDelivery: undefined, attachment });
  }

  private async deliver(request: AgentChatSend): Promise<AgentChatReceipt | undefined> {
    this.publish({ delivering: true });
    try {
      const receipt = await this.transport.send(this.panelId, request);
      this.confirm(receipt, request);
      await this.refresh();
      this.setError(receipt.state === 'failed' ? receipt.error : undefined);
      return receipt;
    } catch (error) {
      this.setError(`${error instanceof Error ? error.message : String(error)} Check delivery before sending again.`);
    } finally { this.publish({ delivering: false }); }
  }

  async checkDelivery(retry: boolean): Promise<AgentChatReceipt | undefined> {
    const request = this.state.pendingDelivery;
    if (!request || this.state.delivering) return;
    if (retry) {
      if (this.loadedTransportRevision !== this.transportRevision) {
        this.setError('The host connection changed. Refresh the conversation before retrying this delivery.');
        return;
      }
      const conversation = this.state.view?.conversation;
      if (!conversation || conversation.nativeSessionId !== this.deliveryConversation || conversation.generation !== request.generation) {
        this.setError('This delivery belongs to an earlier conversation or runtime. Check its receipt on the original host before sending again.');
        return;
      }
      return this.deliver(request);
    }
    this.publish({ delivering: true });
    try {
      const receipt = await this.transport.receipt(this.panelId, request.operationId);
      if (!receipt) {
        this.setError('The host has no receipt yet. Retry this same delivery explicitly when connected.');
        return;
      }
      this.confirm(receipt, request);
      await this.refresh();
      this.setError(receipt.state === 'failed' ? receipt.error : undefined);
      return receipt;
    } catch (error) { this.setError(error instanceof Error ? error.message : String(error)); }
    finally { this.publish({ delivering: false }); }
  }
}
