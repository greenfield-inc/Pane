/**
 * Timing marks along the Session switch path, read by tests/session-switch-latency.spec.ts.
 *
 * Off unless a test installs `globalThis.__paneSwitchMarks` (an array): every call is then
 * pushed there with `performance.now()` and also recorded as a `pane-switch:<name>` User
 * Timing mark, so a Chrome trace shows them too. Without the array a call does nothing.
 *
 * The names, in switch order: `open` (a row's click or Enter), `session:get:start` and
 * `session:get:end` (the Session view), `panels:start` and `panels:loaded` (the workspace
 * layout), `chat:mount`, `chat:get:start` and `chat:get:end` (the chat's newest window),
 * `chat:ready` (a starting agent finished replaying) and `chat:commit` (messages on screen).
 */
/** Which Session or chat the step belongs to, and what a chat read returned. */
export interface SwitchMarkDetail {
  sessionId?: string;
  panelId?: string;
  status?: string;
  start?: number;
  n?: number;
  /** Another machine's Session (T-116 PR 6): the machine it is on. */
  machineId?: string;
}

export interface SwitchMark {
  name: string;
  detail: SwitchMarkDetail;
  t: number;
}

declare global {
  var __paneSwitchMarks: SwitchMark[] | undefined;
}

export function switchMark(name: string, detail: SwitchMarkDetail): void {
  const sink = globalThis.__paneSwitchMarks;
  if (!Array.isArray(sink)) return;
  const t = performance.now();
  sink.push({ name, detail, t });
  performance.mark(`pane-switch:${name}`, { startTime: t, detail });
}
