export interface DraftSnapshot { readonly key: string | null; readonly text: string; readonly revision: number }
interface Storage { read(key: string): string; write(key: string, text: string): void }
const empty: DraftSnapshot = { key: null, text: '', revision: 0 };

/** Draft identity outlives a screen. Receipts clear only the revision sent. */
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
    this.drafts.set(key, { key, text, revision: current.revision + 1 });
    this.storage.write(key, text);
    this.listeners.get(key)?.forEach(listener => listener());
  }

  confirm(sent: DraftSnapshot): void {
    if (sent.key && this.read(sent.key) === sent) this.update(sent.key, '');
  }
}
