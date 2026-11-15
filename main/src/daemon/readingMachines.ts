/**
 * The Pane installs (by `AppConfig.machineId`) holding a live event stream to this computer, over
 * its paired or its Tailscale transport: each one is reading this computer's cards. Only the owner
 * or a paired device counts, the callers that may change "Show cards on".
 */
const streams = new Map<string, number>();
const arrivals = new Set<(machineId: string) => void>();

export const readingMachines = {
  add(machineId: string): void {
    streams.set(machineId, (streams.get(machineId) ?? 0) + 1);
    for (const listener of arrivals) listener(machineId);
  },
  /** Calls `listener` each time a Pane install opens a stream, even while an older one is still counted. Returns the unsubscribe. */
  onArrive(listener: (machineId: string) => void): () => void {
    arrivals.add(listener);
    return () => { arrivals.delete(listener); };
  },
  remove(machineId: string): void {
    const left = (streams.get(machineId) ?? 0) - 1;
    if (left > 0) streams.set(machineId, left);
    else streams.delete(machineId);
  },
  has(machineId: string): boolean {
    return streams.has(machineId);
  },
};
