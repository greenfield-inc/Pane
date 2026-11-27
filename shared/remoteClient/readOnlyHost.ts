import type { JsonValue } from '../validation/boundaryDecoder';

/**
 * What a client sends by itself while it shows a computer (bookkeeping, and reads of what a read-only
 * device has no business with), and what it takes as the answer instead of asking a computer that gives
 * it read-only access. Everything the person asks for still goes to the host, whose refusal shows.
 */
export const READ_ONLY_HOST_ANSWERS: ReadonlyMap<string, JsonValue> = new Map<string, JsonValue>([
  // Viewer bookkeeping: nothing to keep on someone else's computer.
  ['sessions:set-active-session', { success: true }],
  ['git:cancel-status-for-project', { success: true }],
  ['projects:activate', { success: true }],
  ['panels:set-layout', { success: true }],
  ['panels:clearUnviewedContent', { success: true }],
  ['panels:emitEvent', null],
  ['terminal:saveSnapshot', null],
  ['browser:watch', null],
  // Git is read for controls a watched Pane doesn't show; its cached status comes with the Pane.
  ['sessions:get-git-status', { success: false }],
  ['sessions:get-git-commands', { success: false }],
  ['sessions:has-changes-to-rebase', { success: true, data: false }],
  ['sessions:has-stash', { success: true, data: false }],
  ['sessions:get-upstream', { success: true, data: null }],
  ['git:get-github-remote', { success: true, data: null }],
  // Nothing to resume, create, run, answer, clean up or forward.
  ['panels:shouldAutoCreate', false],
  ['projects:resolve-run-script', { success: true, data: null }],
  ['sessions:get-output', { success: true, data: [] }],
  ['sessions:get-resumable', { success: true, data: [] }],
  ['archive:get-progress', { success: true, data: null }],
  ['permission:getPending', { success: true, data: [] }],
  ['notify:remote-snapshot', null],
  ['ports:list', { host: '', ports: [] }],
]);
