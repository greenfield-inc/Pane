import { useEffect, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

/**
 * Copies text: the Clipboard API where the page may use it, else the older copy
 * command (the PWA over plain HTTP has no Clipboard API).
 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand('copy')) throw new Error('This browser did not allow copying.');
  } finally {
    field.remove();
  }
}

/**
 * Copies text that is still loading. The clipboard write starts inside the click, with the text
 * as a promised Blob, because Safari drops the click's permission across an await; without
 * ClipboardItem it copies once the text arrives.
 */
function copyLoading(text: Promise<string>): Promise<void> {
  if (navigator.clipboard?.write && window.isSecureContext && 'ClipboardItem' in window) {
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) })]);
  }
  return text.then(copyText);
}

/**
 * A copy button whose icon turns into a check (or a cross, if copying failed) for a moment.
 * `text` may load what it copies; if that rejects, nothing is copied.
 */
export function ChatCopyButton({ label, text, className = 'chat-copy', showLabel = false }: { label: string; text: () => string | Promise<string>; className?: string; showLabel?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  const status = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : label;
  return <button type="button" className={className} data-state={state} aria-label={label} title={status}
    onClick={() => {
      let copying: Promise<void>;
      try {
        const content = text();
        copying = content instanceof Promise ? copyLoading(content) : copyText(content);
      } catch (error) {
        copying = Promise.reject(error);
      }
      copying.then(() => setState('copied'), () => setState('failed'));
    }}>
    <span className="chat-copy-icon"><Icon aria-hidden="true" /></span>
    {showLabel && <span>{status}</span>}
    <span className="sr-only" role="status">{state === 'idle' ? '' : status}</span>
  </button>;
}
