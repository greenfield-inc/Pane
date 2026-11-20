/** How long the ptyHost waits for a Windows terminal's process id before answering spawn anyway. */
const SPAWNED_PID_TIMEOUT_MS = 5_000;
const POLL_MS = 10;

/**
 * Resolve a just-spawned pty's process id. On Windows node-pty connects to
 * ConPTY after `spawn()` returns, so `pid` reads 0 until that connect lands.
 * Stops waiting when the process exits or after `timeoutMs`, and then returns
 * whatever `pid` holds (0 when the connect never landed).
 */
export async function waitForSpawnedPid(
  pty: { readonly pid: number },
  hasExited: () => boolean,
  timeoutMs = SPAWNED_PID_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (pty.pid <= 0 && !hasExited() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  return pty.pid;
}
