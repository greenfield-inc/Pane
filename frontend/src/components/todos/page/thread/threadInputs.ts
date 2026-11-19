import type { NotifyItem } from '../../../../../../shared/types/notify';
import type { TodoAttachment, TodoDetail } from '../../../../../../shared/types/todos';
import type { TodoThreadApproval } from '../../../../../../shared/todoThread';
import { approvalCardView } from '../chatEntries';

/**
 * The tabs mid-turn now, from what the page already reads: a to-do reads Working only while its
 * working tab (the assignee's, else the orchestrator's) passes the Session spinner's settled test,
 * and a sub-to-do's row the same for its own.
 */
export function todoMidTurnTabs(detail: TodoDetail): Set<string> {
  const tabs = new Set<string>();
  const orchestrator = detail.orchestrator?.panelId;
  const add = (assignee: string | undefined) => {
    const tab = assignee ?? orchestrator;
    if (tab) tabs.add(tab);
  };
  if (detail.status.status === 'working') add(detail.todo.assignee?.panelId);
  for (const sub of detail.subTodos) if (sub.status.status === 'working') add(sub.todo.assignee?.panelId);
  return tabs;
}

/** The to-do's approvals still in the Approvals snapshot, as the thread reads them. */
export function todoThreadApprovals(items: readonly NotifyItem[], approvalIds: readonly string[]): TodoThreadApproval[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const approvals: TodoThreadApproval[] = [];
  for (const id of approvalIds) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    const view = approvalCardView(item);
    const approval: TodoThreadApproval = { id, question: view.question, state: view.state, createdAt: item.createdAt };
    if (view.qn) approval.qn = view.qn;
    if (item.source.panelId) approval.askerTab = item.source.panelId;
    // Pane's own cards (a reminder, a stuck to-do) are asked by Pane, not by the to-do.
    if (item.source.agent === 'Pane' && !item.source.panelId) approval.askerName = 'Pane';
    else if (item.source.name) approval.askerName = item.source.session?.orchestrator ? 'orchestrator' : item.source.name;
    if (view.answer) approval.answer = view.answer;
    const options = item.choices?.length ?? item.questions?.length;
    if (options) approval.optionCount = options;
    if (item.resolvedAt !== undefined) approval.resolvedAt = item.resolvedAt;
    approvals.push(approval);
  }
  return approvals;
}

/** "planner attached plan: Plan (from …)" → "Plan": the label an attach event names. */
export function attachedLabel(body: string): string | undefined {
  const match = /\battached [\w-]+: (.+?)(?: \(.*\))?$/u.exec(body.trim());
  return match?.[1];
}

/** The to-do's own or inherited attachment an event names, if it's still attached. */
export function attachmentNamed(detail: TodoDetail, label: string): TodoAttachment | undefined {
  for (const group of detail.attachments) {
    const found = group.attachments.find((attachment) => attachment.label === label && attachment.removedAt === undefined);
    if (found) return found;
  }
  return undefined;
}

/** The to-do's own or inherited attachment at a file path (the path a comment's Attached line names), if it's still attached. */
export function attachmentAt(detail: TodoDetail, path: string): TodoAttachment | undefined {
  for (const group of detail.attachments) {
    const found = group.attachments.find((attachment) => attachment.target === path && attachment.removedAt === undefined);
    if (found) return found;
  }
  return undefined;
}

/** A file the person attached from the composer: now a to-do attachment, named in the comment. */
export interface ComposerFile {
  name: string;
  path: string;
}

/** The comment's words, then a line per file so the agent can open it. */
export function commentWithFiles(body: string, files: readonly ComposerFile[]): string {
  const lines = files.map((file) => `Attached ${file.name}: ${file.path}`);
  return [body.trim(), ...lines].filter(Boolean).join('\n\n');
}

/** The last part of a path, for a file's name. */
export function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/** Files on the clipboard or in a drop, as a plain list. */
export function eventFiles(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}
