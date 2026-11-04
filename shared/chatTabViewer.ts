import { applyChatTabEvent, type ChatTabClient, type ChatTabEvent, type ChatTabSend, type ChatTabTranscript, type ChatTabView } from './types/chatTab';

export interface ChatTabViewerState {
  view?: ChatTabView;
  transcript?: ChatTabTranscript;
  error?: string;
  draft: string;
  /** A send whose receipt has not come back; kept so it can be checked or retried with the same ID. */
  pendingDelivery?: ChatTabSend;
  loadingEarlier: boolean;
}

/** Messages a viewer keeps mounted. Older ones are paged in from the host when scrolled to. */
const WINDOW = 600;
const PAGE = 100;

/**
 * A disposable subscription to one chat tab's host state. Detaching has no
 * effect on the agent; the draft and an unconfirmed send survive tab switches.
 */
export class ChatTabViewer {
  private state: ChatTabViewerState = { draft: '', loadingEarlier: false };
  private readonly listeners = new Set<() => void>();
  private detach?: () => void;
  private loading?: Promise<void>;
  private pending: ChatTabEvent[] = [];

  constructor(readonly client: ChatTabClient, readonly panelId: string) {}

  snapshot = (): ChatTabViewerState => this.state;

  private publish(patch: Partial<ChatTabViewerState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  setDraft(draft: string): void { this.publish({ draft }); }
  setPendingDelivery(pendingDelivery?: ChatTabSend): void { this.publish({ pendingDelivery }); }
  setError(error?: string): void { this.publish({ error }); }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach) {
      const events = this.client.onEvent(event => {
        if (event.panelId !== this.panelId) return;
        const transcript = this.state.transcript;
        if (this.loading || !transcript) { if (this.pending.length < 2000) this.pending.push(event); return; }
        const applied = applyChatTabEvent(transcript, event);
        if (applied.resync) { void this.refresh(); return; }
        this.publish({ transcript: this.bounded(applied.transcript) });
      });
      const states = this.client.onState(view => {
        if (view.panelId !== this.panelId) return;
        if (view.generation < (this.state.view?.generation ?? 0)) return;
        const newGeneration = view.generation !== this.state.transcript?.generation;
        // History replays while a tab starts; the window is only complete once it has.
        const finishedStarting = this.state.view?.status === 'starting' && view.status !== 'starting';
        this.publish({ view: { ...view, transcript: undefined } });
        if ((newGeneration || finishedStarting) && view.status !== 'starting') void this.refresh();
      });
      const reconnect = this.client.onReconnect?.(() => { void this.refresh(); });
      this.detach = () => { events(); states(); reconnect?.(); };
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.detach?.();
        this.detach = undefined;
        // Keep the draft and an unconfirmed send; release the heavy transcript.
        this.state = { ...this.state, transcript: undefined };
        this.pending = [];
      }
    };
  };

  /** A fresh snapshot of the newest window, then any events that arrived while it loaded. */
  refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.client.get(this.panelId, PAGE * 2).then(view => {
      let transcript = view.transcript;
      let gap = false;
      for (const event of this.pending) {
        if (!transcript) break;
        const applied = applyChatTabEvent(transcript, event);
        transcript = applied.transcript;
        gap ||= applied.resync;
      }
      this.pending = [];
      this.publish({ view: { ...view, transcript: undefined }, transcript, error: gap ? this.state.error : this.state.pendingDelivery ? this.state.error : undefined });
      if (gap) queueMicrotask(() => void this.refresh());
    }).catch(error => this.setError(error instanceof Error ? error.message : String(error))).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  /** Pages in older messages above the window. */
  async loadEarlier(): Promise<void> {
    const transcript = this.state.transcript;
    if (!transcript || transcript.start === 0 || this.state.loadingEarlier) return;
    this.publish({ loadingEarlier: true });
    try {
      const older = await this.client.history(this.panelId, transcript.start, PAGE);
      const current = this.state.transcript;
      if (!current || current.generation !== transcript.generation || current.start !== transcript.start) return;
      this.publish({ transcript: { ...current, start: current.start - older.length, messages: [...older, ...current.messages] } });
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    } finally { this.publish({ loadingEarlier: false }); }
  }

  /** Keeps the newest WINDOW messages mounted while following the end of the chat. */
  private bounded(transcript: ChatTabTranscript): ChatTabTranscript {
    const extra = transcript.messages.length - WINDOW;
    if (extra <= PAGE) return transcript;
    return { ...transcript, start: transcript.start + extra, messages: transcript.messages.slice(extra) };
  }
}

const viewers = new WeakMap<ChatTabClient, Map<string, ChatTabViewer>>();
export function chatTabViewer(client: ChatTabClient, panelId: string): ChatTabViewer {
  let byPanel = viewers.get(client);
  if (!byPanel) { byPanel = new Map(); viewers.set(client, byPanel); }
  let viewer = byPanel.get(panelId);
  if (!viewer) { viewer = new ChatTabViewer(client, panelId); byPanel.set(panelId, viewer); }
  return viewer;
}
