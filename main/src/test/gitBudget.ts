/**
 * Time budget for tests that start real processes (git, Node), so every such
 * test derives its timeout the same way: the processes it starts, counted,
 * times the worst per-start cost measured on Windows CI.
 *
 * 700 ms per start: the worst Windows case in the 22 Code Quality runs of
 * 2026-11-19 (PR #1623) was git-operation-arguments' "reports a real conflict
 * against the literal comparison ref", 4.1 s for about 6 timed git starts
 * (about 680 ms each), rounded up.
 *
 * Git counts are measured, not estimated: run the test alone with
 * GIT_TRACE2_EVENT=<file> and count the `"event":"start"` lines. The count
 * includes the test's hooks and setup, so it is an upper bound on the git
 * starts inside the timed body.
 */
export const PROCESS_START_BUDGET_MS = 700;

/** Timeout in ms for a test that starts `count` git processes (counted as above). */
export function gitSteps(count: number): number {
  return count * PROCESS_START_BUDGET_MS;
}
