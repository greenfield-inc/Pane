/** What one request came to: its own result, or that a newer request replaced it. */
type LatestSwitchResult<Value> =
  | { superseded: false; value: Value }
  /** A newer request came in. `value` is set when this one had already started and finished anyway. */
  | { superseded: true; value?: Value };

export interface LatestSwitch<Target, Value> {
  /** Queues a switch and returns at once; it runs when the one in flight ends, unless a newer request replaces it. */
  request(target: Target): Promise<LatestSwitchResult<Value>>;
  /** Whether request number `ticket` (1 for the first) has been replaced by a newer one. */
  isSuperseded(ticket: number): boolean;
  /** The number the next request gets, minus one: the newest request's ticket. */
  latestTicket(): number;
}

/**
 * Runs one machine switch at a time, latest wins (T-128, D-6). The host connection switches one
 * machine at a time, so a press made while a switch runs used to be dropped. Now it waits for that
 * switch to end and then runs, and a still newer press replaces it while it waits. The caller is
 * never held up to make a press: `request` queues and returns.
 */
export function createLatestSwitch<Target, Value>(
  run: (target: Target) => Promise<Value>,
  options: {
    /**
     * Called when a press queues behind the switch in flight, so that switch can stop early instead
     * of making the newer one wait for it (D-6). Its result still settles the running request.
     */
    cancel?: (running: Target, next: Target) => void;
  } = {},
): LatestSwitch<Target, Value> {
  let ticketCount = 0;
  let running: { target: Target } | null = null;
  let waiting: { ticket: number; target: Target; settle: (result: Promise<LatestSwitchResult<Value>>) => void } | null = null;

  const start = (ticket: number, target: Target): Promise<LatestSwitchResult<Value>> => {
    running = { target };
    const ran = run(target);
    void ran.catch(() => undefined).finally(() => {
      running = null;
      const next = waiting;
      waiting = null;
      if (next) next.settle(start(next.ticket, next.target));
    });
    return ran.then(value => (ticket === ticketCount ? { superseded: false, value } : { superseded: true, value }));
  };

  return {
    request(target) {
      const ticket = ++ticketCount;
      if (!running) return start(ticket, target);
      waiting?.settle(Promise.resolve({ superseded: true }));
      const queued = new Promise<LatestSwitchResult<Value>>((resolve) => {
        waiting = { ticket, target, settle: result => resolve(result) };
      });
      options.cancel?.(running.target, target);
      return queued;
    },
    isSuperseded: ticket => ticket !== ticketCount,
    latestTicket: () => ticketCount,
  };
}
