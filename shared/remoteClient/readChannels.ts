// Retry only reviewed reads. A command name or runtime ID cannot prove that
// replaying it is safe after the host applied it but its response was lost.
export const REMOTE_READ_CHANNELS = new Set([
  'agent-chat:get',
  'agent-chat:receipt',
  'runpane:update:progress',
  'config:get',
  'config:get-session-preferences',
  'ui-state:get-expanded',
  'ui-state:get-navigation-memory',
  'ui-state:get-session-workspace-layout',
  'ui-state:get-pane-layout',
  'sessions:get-all',
  'sessions:get-all-with-projects',
  'sessions:get-output',
  'sessions:get-conversation',
  'sessions:get-conversation-messages',
  'sessions:get-json-messages',
  'panels:get-layout',
  'panels:get-conversation-messages',
  'panels:get-json-messages',
  'panels:get-prompts',
  'orchestration-sessions:list',
  'orchestration-sessions:get',
  'orchestration-sessions:overview',
  'orchestration-sessions:runtimes',
  'projects:get-all',
  'projects:get-running-script',
  'terminal:getAltScreenState',
  'terminal:getScrollbackClean',
  'sessions:get',
  'panels:list',
  'panels:getActive',
  'panels:agent-statuses',
  'panels:checkInitialized',
  'panels:get-output',
  'ports:list',
  'projects:list-branches',
  'projects:detect-branch',
  'remote:pwa-affordances',
  'mobile:push-status',
  'runpane:workspace:state',
  'runpane:workspaces:machines',
  'runpane:loops:list',
  'runpane:loops:preview',
  'loops:list',
  'loops:preview',
  'permission:getPending',
  'notify:remote-snapshot',
  'sessions:get-archived-with-projects',
  'terminal:getState',
  // Cleans up a dictation's text; the host keeps nothing, so a lost answer can be asked again.
  'voice:finalize-streaming',
  // Read a terminal's screen or saved output; glasses poll the screen every second.
  'runpane:panels:screen',
  'runpane:panels:output',
  // Read a worktree folder or text file; nothing on the host changes.
  'file:list',
  'file:read',
]);


/** Mutations the host de-duplicates by the operation ID they carry, so a retry cannot apply twice. */
export const REMOTE_DEDUPLICATED_CHANNELS = new Set(['agent-chat:send']);

/**
 * Idempotent device bookkeeping a phone sends to every saved computer without opening its
 * workspace stream: push registration (an upsert per install) and shared-key sync (newest wins).
 */
export const REMOTE_STREAMLESS_CHANNELS = new Set([
  'credentials:shared:get', 'credentials:shared:apply',
  'mobile:push-register', 'mobile:push-controls', 'mobile:push-revoke',
]);

/** Idempotent viewer bookkeeping required to restore a connected workspace. */
export const REMOTE_RESTORE_CHANNELS = new Set([
  'terminal:resize', 'panels:resize-terminal', 'terminal:setVisibility',
  'terminal:ack', 'terminal:resetFlowControl', 'sessions:mark-viewed',
  'panels:set-active', 'terminal:reply',
]);

/** A host that runs each request id once refuses a write with this code, before running it, while its memory of answers is full; resending is safe. */
export const REMOTE_WRITES_BUSY_CODE = 'ERR_REMOTE_WRITES_BUSY';
