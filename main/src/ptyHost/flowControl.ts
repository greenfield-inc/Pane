/**
 * Per-ptyId flow-control bookkeeping across the ptyHost async seam.
 *
 * Encodes the VS Code `FlowControlConstants` triple (100 000 / 5 000 / 5 000)
 * that the plan has decided to adopt. Note: the existing main-side constant
 * at `terminalPanelManager.ts:14` is currently `LOW_WATERMARK = 10_000`; this
 * module uses the new aligned value of `5_000` (matching the renderer's
 * `ACK_BATCH_SIZE`). Task 5 in the plan migrates `terminalPanelManager.ts`
 * and `TerminalPanel.tsx` to this value in lockstep.
 *
 * The key subtlety is the `pauseRpcInFlight` gate: when we send a pause RPC
 * to the host we don't know when it actually lands, so a saturated main event
 * loop could fire the safety-resume timer and force-resume before pause even
 * applies. To defeat this, the safety timer is armed ONLY after the pause RPC
 * resolves (plan lines 619-624), and the safety-resume callback is a no-op
 * while the pause RPC is still in flight (plan gotcha at line 762).
 */

/** Pause the host PTY when pending bytes reach this watermark. */
export const HIGH_WATERMARK = 100_000;

/**
 * Resume the host PTY when pending bytes drop to this watermark.
 *
 * NOTE: main's `terminalPanelManager.ts` still has `LOW_WATERMARK = 10_000`
 * at the time this module is introduced. This module uses the new aligned
 * value; Task 5 updates the main-side constant and the renderer's
 * `ACK_BATCH_SIZE` together so the three numbers match.
 */
export const LOW_WATERMARK = 5_000;

/**
 * Force-resume a stuck pause after this many ms if no acks arrive.
 *
 * Matches the existing `PAUSE_SAFETY_TIMEOUT` at `terminalPanelManager.ts:17`.
 * Only runs while `pauseRpcInFlight` is false; a pause RPC that is still in
 * flight must be allowed to land first.
 */
export const PAUSE_SAFETY_TIMEOUT = 5_000;

/**
 * Per-ptyId flow-control state. One record per live PTY on the main side.
 *
 * Fields mirror the shape of `TerminalProcess` at `terminalPanelManager.ts:21-43`
 * (`pendingBytes`, `isPaused`, `pauseSafetyTimer`) plus the new
 * `pauseRpcInFlight` gate required by the async seam.
 */
export interface FlowControlRecord {
  pendingBytes: number;
  isPaused: boolean;
  pauseSafetyTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True between posting a `pause` RPC and receiving its response. While this
   * is true, the safety timer is NOT armed, and any already-armed timer's
   * resume callback must short-circuit. Prevents a stalled main event loop
   * from force-resuming a PTY we just tried to pause.
   */
  pauseRpcInFlight: boolean;
}

/**
 * Construct a fresh flow-control record in the default (running) state.
 */
export function createFlowControlRecord(): FlowControlRecord {
  return {
    pendingBytes: 0,
    isPaused: false,
    pauseSafetyTimer: null,
    pauseRpcInFlight: false,
  };
}

/**
 * Callback invoked when the high watermark is first crossed.
 *
 * The caller awaits this; typically it posts a `pause` RPC to the ptyHost and
 * returns the resulting promise. `onPtyBytes` uses the promise's resolution to
 * know when to arm the safety timer (see `handleBytes` implementation).
 */
export type PauseCallback = () => Promise<void>;

/**
 * Callback invoked when the low watermark is crossed with bytes still paused.
 *
 * Like `PauseCallback`, typically posts a `resume` RPC to the ptyHost. The
 * caller is not required to await it; the record flips `isPaused` synchronously
 * so subsequent `onAck` calls don't double-resume.
 */
export type ResumeCallback = () => void;

/**
 * Called when `length` new bytes arrive from the host for a given ptyId.
 *
 * Increments `pendingBytes`. If we cross the high watermark and aren't already
 * paused, marks the record paused, sets `pauseRpcInFlight = true`, invokes
 * `onPause()`, and arms the safety timer only after the pause RPC resolves -
 * per plan lines 619-624.
 *
 * Any error thrown by `onPause` is swallowed: the record stays marked paused,
 * `pauseRpcInFlight` clears, and the safety timer is armed as a fallback so a
 * stuck pause still gets force-resumed eventually.
 */
export function onPtyBytes(
  record: FlowControlRecord,
  length: number,
  onPause: PauseCallback,
  onResume: ResumeCallback,
): void {
  record.pendingBytes += length;
  if (record.pendingBytes < HIGH_WATERMARK || record.isPaused) {
    return;
  }

  record.isPaused = true;
  record.pauseRpcInFlight = true;

  // Arm the safety timer only after the pause RPC lands (or fails). While the
  // RPC is in flight, any pre-existing timer's callback short-circuits because
  // `pauseRpcInFlight` is true (see `armSafetyTimer`).
  onPause()
    .catch(() => {
      // Swallow; treat as "pause couldn't be delivered". The safety timer
      // below will fire eventually and force-resume.
    })
    .finally(() => {
      record.pauseRpcInFlight = false;
      armSafetyTimer(record, onResume);
    });
}

/**
 * Called when the renderer acks `bytes` bytes of processed output.
 *
 * Decrements `pendingBytes`. If we drop to or below the low watermark and the
 * record is paused, clears the safety timer and invokes `onResume()`.
 * Clearing `isPaused` is synchronous so a subsequent `onAck` doesn't race
 * another resume.
 */
export function onAck(
  record: FlowControlRecord,
  bytes: number,
  onResume: ResumeCallback,
): void {
  record.pendingBytes = Math.max(0, record.pendingBytes - bytes);
  if (record.pendingBytes > LOW_WATERMARK || !record.isPaused) {
    return;
  }
  if (record.pauseSafetyTimer) {
    clearTimeout(record.pauseSafetyTimer);
    record.pauseSafetyTimer = null;
  }
  record.isPaused = false;
  onResume();
}

/**
 * Clean up a record's timers. Call when the PTY exits so stale safety timers
 * don't keep the event loop alive.
 */
export function disposeFlowControlRecord(record: FlowControlRecord): void {
  if (record.pauseSafetyTimer) {
    clearTimeout(record.pauseSafetyTimer);
    record.pauseSafetyTimer = null;
  }
  record.isPaused = false;
  record.pauseRpcInFlight = false;
  record.pendingBytes = 0;
}

/**
 * Arm the 5-second safety timer that force-resumes a stuck pause.
 *
 * The timer's callback checks `pauseRpcInFlight` first and short-circuits if
 * a pause RPC has been re-issued in the meantime; this is the guard that
 * defeats the race described in the module header.
 */
function armSafetyTimer(record: FlowControlRecord, onResume: ResumeCallback): void {
  if (record.pauseSafetyTimer) {
    clearTimeout(record.pauseSafetyTimer);
  }
  record.pauseSafetyTimer = setTimeout(() => {
    record.pauseSafetyTimer = null;
    // Suppress force-resume while another pause RPC is still in flight.
    if (record.pauseRpcInFlight) {
      return;
    }
    if (!record.isPaused) {
      return;
    }
    // A timeout abandons the unacknowledged backlog. Keeping it would pause
    // again on the very next byte forever. ACKs carry no sequence, so we cannot
    // distinguish late ACKs from fresh ones after this recovery. Carrying old
    // debt forward would stall a recovered viewer when those ACKs were lost.
    // Fresh output still uses the normal high/low watermarks.
    record.pendingBytes = 0;
    record.isPaused = false;
    onResume();
  }, PAUSE_SAFETY_TIMEOUT);
}
