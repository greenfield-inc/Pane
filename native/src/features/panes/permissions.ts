import type { PanePermissionRequest } from '@shared/types/permissions';

const TARGET_FIELDS = ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'query'];

/** Turns a tool call waiting for approval into something readable on a phone. */
export function describePermission(request: PanePermissionRequest): { title: string; target?: string; detail: string } {
  const field = TARGET_FIELDS.find(name => typeof request.input[name] === 'string');
  return {
    title: request.toolName === 'Bash' ? 'Run a command' : `Use ${request.toolName}`,
    target: field ? String(request.input[field]) : undefined,
    detail: JSON.stringify(request.input, null, 2),
  };
}

/** Pane ID → the request it has waited on longest (the one the agent is stuck on). */
export function pendingByPane(requests: PanePermissionRequest[]): Record<string, PanePermissionRequest> {
  const byPane: Record<string, PanePermissionRequest> = {};
  for (const request of requests) {
    const current = byPane[request.sessionId];
    if (!current || request.timestamp < current.timestamp) byPane[request.sessionId] = request;
  }
  return byPane;
}
