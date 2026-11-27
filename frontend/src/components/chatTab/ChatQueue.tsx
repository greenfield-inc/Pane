import { useRef, useState, type ReactNode } from 'react';
import { Pencil, X, Zap } from 'lucide-react';
import type { ChatTabQueuedPrompt } from '../../../../shared/types/chatTab';
import { messageReferences } from '../../../../shared/composerMentions';
import { ComposerHighlight } from './ComposerHighlight';
import { sendNowEffect } from './chatKeys';

/** The host keeps this many characters of a queued message as its preview; a longer one shows an ellipsis and cannot be edited from it. */
const PREVIEW_LIMIT = 500;

const NO_SKILLS: ReadonlySet<string> = new Set();

export interface ChatQueueProps {
  queue: readonly ChatTabQueuedPrompt[];
  /** A turn is running, so Send now is offered. */
  working: boolean;
  /** Send now delivers into the running turn instead of stopping it. */
  steers?: boolean;
  disabled: boolean;
  /** The tab's skills, marked in the edit box as in a sent message. */
  skills?: ReadonlySet<string>;
  /** Shown instead of the text, such as Autopilot's own lines; such a line is not editable. */
  label?: (text: string) => ReactNode | undefined;
  onRemove: (operationId: string) => void;
  onSendNow: (operationId: string) => void;
  onEdit: (operationId: string, text: string) => Promise<boolean>;
}

/**
 * Messages waiting for the agent, in the order they will be sent (D-211): each can be
 * edited, removed, or sent now (see sendNowEffect).
 */
export function ChatQueue({ queue, working, steers, disabled, skills = NO_SKILLS, label, onRemove, onSendNow, onEdit }: ChatQueueProps) {
  const [editing, setEditing] = useState<{ operationId: string; text: string }>();
  const input = useRef<HTMLTextAreaElement>(null);
  if (!queue.length) return null;
  const save = async () => {
    if (!editing) return;
    if (await onEdit(editing.operationId, editing.text)) setEditing(undefined);
  };
  return <ol className="chat-queue" aria-label="Queued messages">
    {queue.map((item, index) => {
      const shown = label?.(item.text);
      const cut = item.text.length >= PREVIEW_LIMIT;
      const editable = shown === undefined && !cut;
      const order = index === 0 ? 'Sends next' : 'Queued';
      if (editing?.operationId === item.operationId) {
        return <li key={item.operationId} className="chat-queue-editing">
          <div className="chat-input-box">
          <ComposerHighlight input={input} text={editing.text} marks={messageReferences(editing.text, skills)} className="chat-queue-input" />
          <textarea ref={input} className="chat-queue-input" aria-label="Edit queued message" autoFocus rows={2} value={editing.text}
            onChange={event => setEditing({ ...editing, text: event.target.value })}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(undefined); }
              else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save(); }
            }} />
          </div>
          <div className="chat-queue-actions">
            <button type="button" className="chat-button chat-button-outline" onClick={() => setEditing(undefined)}>Cancel</button>
            <button type="button" className="chat-button chat-button-primary" disabled={disabled || (!editing.text.trim() && !item.imageCount)} onClick={() => void save()}>Save</button>
          </div>
        </li>;
      }
      return <li key={item.operationId}>
        <span className="chat-queue-text">{shown ?? (item.text ? `${item.text}${cut ? '…' : ''}` : 'Image')}</span>
        {!!item.imageCount && shown === undefined && !!item.text && <span className="chat-queue-label">+{item.imageCount} image{item.imageCount === 1 ? '' : 's'}</span>}
        <span className="chat-queue-label">{order}</span>
        {working && <button type="button" className="chat-queue-now" disabled={disabled} aria-label="Send now"
          title={`Send now: ${sendNowEffect(steers)}`} onClick={() => onSendNow(item.operationId)}>
          <Zap className="h-3.5 w-3.5" aria-hidden /><span className="chat-queue-now-label">Send now</span>
        </button>}
        {editable && <button type="button" className="chat-icon" aria-label="Edit queued message" title="Edit" disabled={disabled}
          onClick={() => setEditing({ operationId: item.operationId, text: item.text })}><Pencil className="h-3.5 w-3.5" /></button>}
        <button type="button" className="chat-icon" aria-label="Remove from queue" title="Remove from queue" disabled={disabled} onClick={() => onRemove(item.operationId)}><X className="h-3.5 w-3.5" /></button>
      </li>;
    })}
  </ol>;
}
