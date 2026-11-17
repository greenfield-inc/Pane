import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { AutopilotDocument } from '../../../../../shared/types/autopilot';
import type { TodoAttachment } from '../../../../../shared/types/todos';
import { todosApi, useTodoDetail } from '../../../stores/todosStore';
import { cn } from '../../../utils/cn';
import { AutopilotWebPage } from '../../autopilot/AutopilotDocument';
import { useNow } from '../../notify/useNow';
import { relativeAge } from '../../notify/notifyFormat';
import { ATTACHMENT_KIND_ICON, attachmentFileName, isWebTarget } from '../page/TodoAttach';
import { splitTabLabel } from '../page/TodoSplit';
import { attachmentTabs, splitItemKey, type TodoSplitItem } from '../page/splitTabs';
import { PHONE_ICON_BUTTON, PHONE_SCROLL, PhoneHeader, PhoneScreen } from './phoneParts';

export interface PhoneTodoFilesProps {
  number: number;
  /** The open tab's key (`attachment:<id>`); the first (the plan) when unset or gone. */
  tab?: string;
  onTab: (tab: string) => void;
  /** "‹ T-12": back to the to-do. */
  onBack: () => void;
}

/**
 * Plan · Files on a phone (D-422): the to-do's attachments full screen. "‹ T-12", the open file's
 * name and Open ↗; the tabs scroll sideways; then who attached it, when, and the document.
 */
export function PhoneTodoFiles({ number, tab, onTab, onBack }: PhoneTodoFilesProps) {
  const detail = useTodoDetail(number);
  const items = useMemo(() => (detail ? attachmentTabs(detail.attachments) : []), [detail]);
  const active = items.find((item) => splitItemKey(item) === tab) ?? items[0];
  const attachment = active?.kind === 'attachment' ? active.attachment : null;
  const strip = useRef<HTMLDivElement>(null);
  // The tab shown is scrolled into the strip, so a tab opened from the thread is in view.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <PhoneScreen testId="phone-todo-files">
      <PhoneHeader
        title={active ? splitTabLabel(active, items) : 'Files'}
        back={{ label: `T-${number}`, onBack }}
        right={attachment ? <OpenOutside attachment={attachment} /> : null}
      />
      {!detail && <p className="m-auto text-[14px] text-text-tertiary" role="status">Opening T-{number}…</p>}
      {detail && items.length === 0 && <p className="m-auto px-6 text-center text-[14px] text-text-tertiary">Nothing attached yet.</p>}
      {items.length > 0 && (
        <div ref={strip} role="tablist" aria-label="Attachments" className="scrollbar-none flex shrink-0 gap-0.5 overflow-x-auto border-b border-border-primary bg-surface-secondary pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]" data-testid="phone-files-tabs">
          {items.map((item) => (
            <FileTab key={splitItemKey(item)} item={item} label={splitTabLabel(item, items)} active={item === active} onPick={() => onTab(splitItemKey(item))} />
          ))}
        </div>
      )}
      {attachment && detail && <AttachmentBody key={attachment.id} attachment={attachment} machine={attachment.machine ?? detail.machine} from={active?.kind === 'attachment' ? active.from : undefined} />}
    </PhoneScreen>
  );
}

function FileTab({ item, label, active, onPick }: { item: TodoSplitItem; label: string; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onPick}
      className={cn('inline-flex h-10 shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-interactive', active ? 'border-interactive font-semibold text-text-primary' : 'border-transparent text-text-secondary')}
      data-testid="phone-files-tab"
      data-key={splitItemKey(item)}
    >
      {label}
    </button>
  );
}

/**
 * Open ↗: a web address in the browser, and a page from the computer in a new tab of its own (the
 * phone can't reach the computer's file, so it opens the copy read here).
 */
function OpenOutside({ attachment }: { attachment: TodoAttachment }) {
  const open = () => {
    const api = todosApi();
    if (!api) return;
    if (isWebTarget(attachment.target)) {
      api.openUrl(attachment.target);
      return;
    }
    // Opened now, inside the tap, so the browser doesn't block it; filled once the file is read.
    const tab = window.open('', '_blank');
    void api.readDoc(attachment.target).then((doc) => {
      const page = docAsPage(doc);
      if (!tab) return;
      if (page) tab.location.href = URL.createObjectURL(page);
      else tab.close();
    }).catch(() => tab?.close());
  };
  return (
    <button type="button" onClick={open} aria-label={`Open ${attachment.label}`} title="Open" className={PHONE_ICON_BUTTON} data-testid="phone-files-open">
      <ExternalLink className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}

/** A read document as a file the browser can show on its own. */
function docAsPage(doc: AutopilotDocument): Blob | null {
  if (doc.kind === 'html' && doc.html !== undefined) return new Blob([doc.html], { type: 'text/html' });
  if (doc.kind === 'text') return new Blob([doc.text], { type: 'text/plain' });
  return null;
}

function AttachmentBody({ attachment, machine, from }: { attachment: TodoAttachment; machine: string; from?: number }) {
  const now = useNow();
  const Icon = ATTACHMENT_KIND_ICON[attachment.kind];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="phone-files-body" data-attachment={attachment.id}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-secondary pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-[12.5px] text-text-tertiary" data-testid="phone-files-bar">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate text-text-secondary" title={attachment.target}>{attachmentFileName(attachment)}</span>
        <span className="shrink-0">· {attachment.addedBy} · {relativeAge(attachment.addedAt, now)}</span>
        {from !== undefined && <span className="shrink-0">· from T-{from}</span>}
      </div>
      {isWebTarget(attachment.target)
        ? <WebAttachment attachment={attachment} />
        : <FileAttachment attachment={attachment} machine={machine} />}
    </div>
  );
}

/** A web address: a phone can't frame most sites, so it opens in the browser. */
function WebAttachment({ attachment }: { attachment: TodoAttachment }) {
  return (
    <div className="m-auto max-w-sm px-6 text-center text-[14px] text-text-secondary">
      <p className="[overflow-wrap:anywhere]">{attachment.target}</p>
      <button type="button" onClick={() => todosApi()?.openUrl(attachment.target)} className="mt-3 inline-flex h-11 items-center gap-1.5 rounded-md px-3 font-medium text-interactive-text">
        Open in the browser <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Whether Pane shows dark now, following the theme class on the root as it changes. */
function useDarkTheme(): boolean {
  const read = () => document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setDark(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);
  return dark;
}

/**
 * A page from the computer, read as its text: no scripts, forms or navigation. A page that sets no
 * colours of its own takes Pane's light or dark (D-163), as a page in the desktop's viewer does.
 */
function SandboxedPage({ html, title }: { html: string; title: string }) {
  const scheme = useDarkTheme() ? 'dark' : 'light';
  const page = html.replace(/^(\s*<!doctype[^>]*>)?/iu, (doctype) => `${doctype}<meta name="color-scheme" content="${scheme}">`);
  // A new frame per scheme: changing a frame's srcdoc would add a step to the browser's history, and back would land in the frame.
  return <iframe key={scheme} title={title} srcDoc={page} sandbox="" style={{ colorScheme: scheme }} className="min-h-0 w-full flex-1 border-0" data-testid="phone-files-page" data-scheme={scheme} />;
}

/** A file from the to-do's machine: a page (no scripts), text, an image, or why it can't show. */
function FileAttachment({ attachment, machine }: { attachment: TodoAttachment; machine: string }) {
  const [doc, setDoc] = useState<AutopilotDocument | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setFailed(null);
    const api = todosApi();
    if (!api) {
      setFailed(`Couldn't reach ${machine}`);
      return;
    }
    void api.readDoc(attachment.target)
      .then((result) => { if (live) setDoc(result); })
      .catch(() => { if (live) setFailed(`Couldn't reach ${machine}`); });
    return () => { live = false; };
  }, [attachment.target, machine, attempt]);

  if (failed) {
    return (
      <div className="m-auto max-w-sm px-6 text-center text-[14px] text-text-secondary" role="status" data-testid="phone-files-failed">
        <p>{failed}</p>
        <button type="button" onClick={() => setAttempt((current) => current + 1)} className="mt-2 h-11 px-3 font-medium text-interactive-text">Retry</button>
      </div>
    );
  }
  if (!doc) return <p className="m-auto text-[14px] text-text-tertiary" role="status">Opening {attachment.label}…</p>;
  if (doc.kind === 'html') {
    // Read as its text (the web app): shown with no scripts, forms or navigation. The desktop loads the file itself.
    return doc.html !== undefined
      ? <SandboxedPage html={doc.html} title={attachment.label} />
      : <AutopilotWebPage src={doc.url} title={attachment.label} />;
  }
  if (doc.kind === 'image') {
    return (
      <div className={cn(PHONE_SCROLL, 'flex items-start justify-center p-4')}>
        <img src={doc.dataUrl} alt={attachment.label} className="max-w-full rounded-md border border-border-primary" />
      </div>
    );
  }
  if (doc.kind === 'text') {
    return <pre className={cn(PHONE_SCROLL, 'whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed text-text-primary')} data-testid="phone-files-text">{doc.text}</pre>;
  }
  return <p className="m-auto max-w-sm px-6 text-center text-[14px] text-text-secondary" role="status" data-testid="phone-files-missing">{doc.message}</p>;
}
