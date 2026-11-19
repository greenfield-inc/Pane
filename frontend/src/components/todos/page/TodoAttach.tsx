import { useState, type ComponentType, type KeyboardEvent } from 'react';
import { Activity, File, FileText, GitPullRequest, Image, Link2, ListChecks, Palette, Scale, SquareCheckBig } from 'lucide-react';
import type { TodoAttachment, TodoAttachmentKind, TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { useTodosStore } from '../../../stores/todosStore';
import { cn } from '../../../utils/cn';

/** A web page rather than a file on a machine. */
export function isWebTarget(target: string): boolean {
  return /^https?:\/\//iu.test(target.trim());
}

/** Each attachment kind's icon, on its split tab, its file bar and its sidebar row. */
export const ATTACHMENT_KIND_ICON = {
  plan: FileText, mockup: Image, design: Palette, pr: GitPullRequest, findings: SquareCheckBig, decision: Scale,
  doc: File, image: Image, link: Link2, status: Activity, checklist: ListChecks,
} as const satisfies Record<TodoAttachmentKind, ComponentType<{ className?: string }>>;

/** The file's own name ("plan.html"), or a URL's host and path. */
export function attachmentFileName(attachment: TodoAttachment): string {
  if (isWebTarget(attachment.target)) {
    try {
      const url = new URL(attachment.target);
      return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return attachment.target;
    }
  }
  return attachment.target.split(/[\\/]/).filter(Boolean).pop() ?? attachment.target;
}

/** Whether the attachment's file can be opened from this computer (on this machine, or a URL). */
export function attachmentIsHere(detail: TodoDetail, attachment: TodoAttachment, activeMachineId: string): boolean {
  if (isWebTarget(attachment.target)) return true;
  return (detail.machineId ?? LOCAL_MACHINE_ID) === LOCAL_MACHINE_ID && activeMachineId === LOCAL_MACHINE_ID;
}

/** Open ↗: a URL in the browser, a page in the browser, any other file with its own app. */
export function openAttachmentOutside(attachment: TodoAttachment): void {
  const target = attachment.target;
  if (isWebTarget(target)) {
    void window.electronAPI.openExternal(target);
    return;
  }
  const fileUrl = `file://${target}`;
  if (/\.html?$/i.test(target)) void window.electronAPI.openLocalPage(fileUrl);
  else void window.electronAPI.openExternal(fileUrl);
}

/** Reveal: shows the file in Finder (or the file manager). */
export function revealAttachment(attachment: TodoAttachment): void {
  void window.electronAPI.invoke('app:showItemInFolder', attachment.target).catch(() => undefined);
}

export interface AttachFieldProps {
  number: number;
  /** Called with the target once Pane attached it, so the split can show it. */
  onAttached: (target: string) => void;
  onClose: () => void;
  className?: string;
}

/** + Attach's field: paste a path or a URL; Enter attaches it, Esc cancels. */
export function AttachField({ number, onAttached, onClose, className }: AttachFieldProps) {
  const act = useTodosStore((state) => state.act);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = target.trim();
    if (!value || busy) return;
    setBusy(true);
    const result = await act({ kind: 'attach', number, target: value });
    setBusy(false);
    if (result) {
      setTarget('');
      onAttached(value);
      onClose();
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      // Esc closes the field, not the page.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <input
      autoFocus
      value={target}
      disabled={busy}
      onChange={(event) => setTarget(event.target.value)}
      onKeyDown={onKey}
      onBlur={() => { if (!target.trim()) onClose(); }}
      placeholder="Paste a path or URL, then ↵"
      aria-label="Attach a file path or URL"
      className={cn('h-6 w-[200px] rounded-md border border-border-interactive bg-surface-primary px-2 text-[12px] normal-case tracking-normal text-text-primary outline-none placeholder:text-text-tertiary', className)}
      data-testid="todo-attach-input"
    />
  );
}
