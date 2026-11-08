import { useState, type ReactNode } from 'react';
import { CornerDownLeft, Pencil, X } from 'lucide-react';
import type { ChatTabQueuedPrompt } from '../../../../shared/types/chatTab';

/** The host keeps this many characters of a queued message as its preview; a longer one cannot be edited from it. */
const PREVIEW_LIMIT = 500;

export interface ChatQueueProps {
  queue: readonly ChatTabQueuedPrompt[];
  /** A turn is running, so Send now interrupts it. */
  working: boolean;
  disabled: boolean;
  /** Shown instead of the text, such as Autopilot's own lines; such a line is not editable. */
  label?: (text: string) => ReactNode | undefined;
  onRemove: (operationId: string) => void;
  onSendNow: (operationId: string) => void;
  onEdit: (operationId: string, text: string) => Promise<boolean>;
}

/**
 * Messages waiting for the agent, in the order they will be sent (D-211): each can be
 * edited, removed, or sent now, which interrupts the running turn and sends it next.
 */
export function ChatQueue({ queue, working, disabled, label, onRemove, onSendNow, onEdit }: ChatQueueProps) {
  const [editing, setEditing] = useState<{ operationId: string; text: string }>();
  if (!queue.length) return null;
  const save = async () => {
    if (!editing) return;
    if (await onEdit(editing.operationId, editing.text)) setEditing(undefined);
  };
  return <ol className="chat-queue" aria-label="Queued messages">
    {queue.map((item, index) => {
      const shown = label?.(item.text);
      const editable = shown === undefined && item.text.length < PREVIEW_LIMIT;
      const order = index === 0 ? 'Sends next' : `${index + 1} in queue`;
      if (editing?.operationId === item.operationId) {
        return <li key={item.operationId} className="chat-queue-editing">
          <textarea className="chat-queue-input" aria-label="Edit queued message" autoFocus rows={2} value={editing.text}
            onChange={event => setEditing({ ...editing, text: event.target.value })}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(undefined); }
              else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save(); }
            }} />
          <div className="chat-queue-actions">
            <button type="button" className="chat-button chat-button-outline" onClick={() => setEditing(undefined)}>Cancel</button>
            <button type="button" className="chat-button chat-button-primary" disabled={disabled || (!editing.text.trim() && !item.imageCount)} onClick={() => void save()}>Save</button>
          </div>
        </li>;
      }
      return <li key={item.operationId}>
        <span className="chat-queue-text">{shown ?? (item.text || 'Image')}</span>
        {!!item.imageCount && shown === undefined && !!item.text && <span className="chat-queue-label">+{item.imageCount} image{item.imageCount === 1 ? '' : 's'}</span>}
        <span className="chat-queue-label">{order}</span>
        {working && <button type="button" className="chat-button chat-button-outline chat-queue-now" disabled={disabled}
          title="Stop the current turn and send this now" onClick={() => onSendNow(item.operationId)}>
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />Send now
        </button>}
        {editable && <button type="button" className="chat-icon" aria-label="Edit queued message" title="Edit" disabled={disabled}
          onClick={() => setEditing({ operationId: item.operationId, text: item.text })}><Pencil className="h-3.5 w-3.5" /></button>}
        <button type="button" className="chat-icon" aria-label="Remove from queue" title="Remove from queue" disabled={disabled} onClick={() => onRemove(item.operationId)}><X className="h-3.5 w-3.5" /></button>
      </li>;
    })}
  </ol>;
}
