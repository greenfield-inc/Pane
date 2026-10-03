import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

// The existing sessions.db owns durability. This narrow interface also permits
// exercising the real SQL with Node's SQLite in tests without Electron's ABI.
type MailboxRow = Record<string, string | number | bigint | Uint8Array | null>;
interface MailboxDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: (string | number)[]): MailboxRow | undefined;
    all(...args: (string | number)[]): MailboxRow[];
    run(...args: (string | number)[]): void;
  };
}

const messageSchema = boundary.object({
  id: boundary.string, sender: boundary.string, recipient: boundary.string,
  body: boundary.string, status: boundary.enumeration('queued', 'received', 'blocked', 'completed', 'failed'),
  reply: boundary.string, revision: boundary.number, updatedAt: boundary.number,
  wake: boundary.enumeration('none', 'attempted'),
});
export type AgentMessage = ReturnType<typeof messageSchema.decode>;
const peerSchema = boundary.object({
  id: boundary.string, agent: boundary.string, receiver: boundary.enumeration('cooperative', 'pi'),
  seenAt: boundary.number,
});

export function mailboxId(value: string | undefined, label = 'peer'): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${label} must contain 1-128 letters, digits, dots, underscores, colons or hyphens.`);
  }
  return value;
}

export class AgentMailbox {
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly db: MailboxDatabase, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_peers (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, receiver TEXT NOT NULL, seenAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL, reply TEXT NOT NULL, revision INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, wake TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages(recipient, status, updatedAt);`);
  }

  register(id: string, agent: string, receiver: 'cooperative' | 'pi' = 'cooperative'): void {
    mailboxId(id);
    if (!agent.trim() || Buffer.byteLength(agent) > 128) throw new Error('agent label must be 1-128 bytes.');
    this.db.prepare(`INSERT INTO agent_peers VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, receiver=excluded.receiver, seenAt=excluded.seenAt`)
      .run(id, agent, receiver, this.now());
  }

  peers() {
    return this.db.prepare('SELECT * FROM agent_peers ORDER BY id LIMIT 1000').all()
      .map(row => decodeBoundary(row, peerSchema))
      .map(peer => ({ ...peer, online: this.now() - peer.seenAt < 120_000 }));
  }

  touch(id: string): void {
    this.db.prepare("UPDATE agent_peers SET seenAt=? WHERE id=? AND receiver='cooperative'").run(this.now(), id);
  }

  get(id: string): AgentMessage {
    const row = this.db.prepare('SELECT * FROM agent_messages WHERE id=?').get(mailboxId(id, 'message id'));
    if (!row) throw new Error(`Unknown message: ${id}`);
    return decodeBoundary(row, messageSchema);
  }

  send(id: string, sender: string, recipient: string, body: string): { message: AgentMessage; duplicate: boolean } {
    mailboxId(id, 'message id'); mailboxId(sender, 'sender'); mailboxId(recipient, 'recipient');
    if (!body.trim() || Buffer.byteLength(body) > 32_768) throw new Error('Message text must be 1-32768 bytes.');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM agent_messages WHERE id=?').get(id);
      if (row) {
        const message = decodeBoundary(row, messageSchema);
        if (message.sender !== sender || message.recipient !== recipient || message.body !== body) {
          throw new Error('Message id already exists with different sender, recipient or text.');
        }
        return { message, duplicate: true };
      }
      this.db.prepare('INSERT INTO agent_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, sender, recipient, body, 'queued', '', 1, this.now(), 'none');
      return { message: this.get(id), duplicate: false };
    });
  }

  inbox(peer: string, claim: boolean, includeReceived = false, limit = 20, id?: string): AgentMessage[] {
    mailboxId(peer);
    if (id !== undefined && this.get(id).recipient !== peer) throw new Error('Message belongs to a different recipient.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1-100.');
    if (claim && includeReceived) throw new Error('Recovery inspection cannot claim received messages again.');
    this.touch(peer);
    const read = () => {
      const rows = this.db.prepare(`SELECT * FROM agent_messages WHERE recipient=? AND (?='' OR id=?) AND
        status IN (${includeReceived ? "'queued', 'received', 'blocked'" : "'queued'"})
        ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END, updatedAt, id LIMIT ?`).all(peer, id ?? '', id ?? '', limit);
      return rows.map(row => {
        const message = decodeBoundary(row, messageSchema);
        if (!claim) return message;
        this.db.prepare("UPDATE agent_messages SET status='received', revision=revision+1, updatedAt=? WHERE id=?")
          .run(this.now(), message.id);
        return this.get(message.id);
      });
    };
    return claim ? this.transaction(read) : read();
  }

  reply(id: string, peer: string, status: 'blocked' | 'completed' | 'failed', reply: string): AgentMessage {
    if (!reply.trim() || Buffer.byteLength(reply) > 4096) throw new Error('Reply must be 1-4096 bytes; reference larger artifacts by path or URL.');
    return this.transaction(() => {
      const message = this.get(id);
      if (message.recipient !== peer) throw new Error('Only the expected recipient can reply.');
      if (message.status === status && message.reply === reply) return message;
      if (message.status === 'queued') throw new Error('Claim the message before replying.');
      if (message.status === 'completed' || message.status === 'failed') throw new Error('A terminal reply is immutable.');
      this.db.prepare('UPDATE agent_messages SET status=?, reply=?, revision=revision+1, updatedAt=? WHERE id=?')
        .run(status, reply, this.now(), id);
      return this.get(id);
    });
  }

  // Persist before touching a PTY: a crash or uncertain write must never trigger
  // automatic replay. A receipt, not a screen transition, proves consumption.
  attemptWake(id: string, sender: string): AgentMessage {
    return this.transaction(() => {
      const message = this.get(id);
      if (message.sender !== sender) throw new Error('Only the sender can request a terminal wake.');
      if (message.wake !== 'none' || message.status !== 'queued') throw new Error('Message was already woken or consumed; inspect it instead of replaying.');
      this.db.prepare("UPDATE agent_messages SET wake='attempted' WHERE id=?").run(id);
      return this.get(id);
    });
  }

  async wait(id: string, peer: string, after = 0, timeoutMs = 60_000) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative integer.');
    const read = () => {
      const message = this.get(id);
      if (message.sender !== peer && message.recipient !== peer) throw new Error('Peer is not a participant in this message.');
      return message;
    };
    const changed = await this.waitFor(() => {
      const message = read();
      return message.revision > after && ['blocked', 'completed', 'failed'].includes(message.status);
    }, timeoutMs);
    return { timedOut: !changed, message: read() };
  }

  async waitInbox(peer: string, claim: boolean, includeReceived: boolean, limit: number, timeoutMs: number, id?: string) {
    // Claims happen after waking, synchronously, so competing consumers cannot
    // claim the same row. A lost response leaves a durable received record.
    const deadline = this.now() + timeoutMs;
    do {
      const messages = this.inbox(peer, claim, includeReceived, limit, id);
      if (messages.length || this.now() >= deadline) return { messages, timedOut: !messages.length };
      const changed = await this.waitFor(() => this.inbox(peer, false, includeReceived, limit, id).length > 0,
        Math.max(0, deadline - this.now()));
      if (!changed) return { messages: [], timedOut: true };
    } while (!this.closed);
    throw new Error('Mailbox is closed.');
  }

  dispose(): void {
    this.closed = true;
    this.notify();
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) throw new Error('Mailbox is closed.');
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Notify only after commit. Queueing also avoids reentrant SQL transactions
    // when an inbox predicate runs while a different reader is committing.
    queueMicrotask(() => this.notify());
    return result;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) throw new Error('timeout must be 0-120000 ms.');
    if (this.closed) return Promise.reject(new Error('Mailbox is closed.'));
    if (predicate()) return Promise.resolve(true);
    if (!timeoutMs) return Promise.resolve(false);
    if (this.listeners.size >= 64) return Promise.reject(new Error('Too many mailbox waiters (maximum 64).'));
    return new Promise((resolve, reject) => {
      const finish = (value: boolean, error?: Error) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        if (error) reject(error); else resolve(value);
      };
      const check = () => {
        try {
          if (this.closed) finish(false, new Error('Mailbox is closed.'));
          else if (predicate()) finish(true);
        } catch (error) {
          finish(false, error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.listeners.add(check);
    });
  }
}
