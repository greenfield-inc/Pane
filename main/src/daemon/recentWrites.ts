/** Longer than a client's five-minute reconnect budget, so every resend it makes finds the first answer. */
const ANSWER_WINDOW_MS = 10 * 60_000;
/** Answers kept per client; the oldest answered ones go first. */
const MAX_ANSWERS_PER_CLIENT = 1024;

export interface InvokeAnswer {
  statusCode: number;
  payload: unknown;
}

interface RecentWrite {
  answer: Promise<InvokeAnswer>;
  answeredAt: number | null;
}

/**
 * Each client's recent writes by the request id it chose, held in memory. A repeat of an id runs
 * nothing: it gets the first answer, waiting for it while the first still runs.
 */
export class RecentWrites {
  private readonly clients = new Map<string, Map<string, RecentWrite>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs = ANSWER_WINDOW_MS,
    private readonly maxPerClient = MAX_ANSWERS_PER_CLIENT,
  ) {}

  /** `run` decides whether its answer is kept; an answer that is not kept lets the next repeat run again. */
  answer(client: string, requestId: string, run: () => Promise<{ answer: InvokeAnswer; keep: boolean }>): Promise<InvokeAnswer> {
    const writes = this.clients.get(client) ?? new Map<string, RecentWrite>();
    this.clients.set(client, writes);
    this.forgetOld(writes);
    const known = writes.get(requestId);
    if (known) return known.answer;

    const write: RecentWrite = {
      answeredAt: null,
      answer: run().then(({ answer, keep }) => {
        if (keep) write.answeredAt = this.now();
        else writes.delete(requestId);
        return answer;
      }),
    };
    writes.set(requestId, write);
    return write.answer;
  }

  private forgetOld(writes: Map<string, RecentWrite>): void {
    const cutoff = this.now() - this.windowMs;
    let excess = writes.size + 1 - this.maxPerClient;
    // Map order is arrival order. A write still running is never forgotten, or its resend would run it twice.
    for (const [id, write] of writes) {
      if (write.answeredAt === null) continue;
      if (write.answeredAt <= cutoff || excess > 0) {
        writes.delete(id);
        excess -= 1;
      }
    }
  }
}
