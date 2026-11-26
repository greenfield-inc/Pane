export interface DraftSnapshot {
  readonly key: string | null;
  readonly text: string;
  readonly revision: number;
  /** The text is on its way and the host hasn't confirmed it yet. */
  readonly sending?: boolean;
}
interface Storage { read(key: string): string; write(key: string, text: string): void }
const empty: DraftSnapshot = { key: null, text: '', revision: 0 };

/** Draft identity outlives a screen, and so does a send in flight. A receipt clears only the revision sent. */
export class DraftStore {
  private readonly drafts = new Map<string, DraftSnapshot>();
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly storage: Storage) {}

  read(key: string | null): DraftSnapshot {
    if (!key) return empty;
    let draft = this.drafts.get(key);
    if (!draft) { draft = { key, text: this.storage.read(key), revision: 0 }; this.drafts.set(key, draft); }
    return draft;
  }

  subscribe(key: string | null, listener: () => void): () => void {
    if (!key) return () => undefined;
    let listeners = this.listeners.get(key);
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners); }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  update(key: string | null, next: string | ((text: string) => string)): void {
    if (!key) return;
    const current = this.read(key);
    const text = typeof next === 'function' ? next(current.text) : next;
    if (text === current.text) return;
    this.drafts.set(key, { ...current, text, revision: current.revision + 1 });
    this.storage.write(key, text);
    this.notify(key);
  }

  confirm(sent: DraftSnapshot): void {
    if (sent.key && this.read(sent.key).revision === sent.revision) this.update(sent.key, '');
  }

  /**
   * Delivers the draft, one send per key at a time: a send while one is in flight does nothing.
   * The text stays until `deliver` resolves, then clears unless it was edited meanwhile; a failed
   * send keeps it and rejects.
   */
  async send(key: string | null, deliver: (text: string) => Promise<void>): Promise<void> {
    if (!key || this.read(key).sending) return;
    const sent = this.read(key);
    this.setSending(key, true);
    try {
      await deliver(sent.text);
      this.confirm(sent);
    } finally {
      this.setSending(key, false);
    }
  }

  private setSending(key: string, sending: boolean): void {
    this.drafts.set(key, { ...this.read(key), sending });
    this.notify(key);
  }

  private notify(key: string): void {
    this.listeners.get(key)?.forEach(listener => listener());
  }
}
