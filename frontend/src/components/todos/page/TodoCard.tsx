import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { TodoDetail } from '../../../../../shared/types/todos';
import { MarkdownPreview, type MarkdownImageProps } from '../../MarkdownPreview';
import { useTodosStore } from '../../../stores/todosStore';
import { cn } from '../../../utils/cn';
import { COMPACT_MARKDOWN, SectionAction, SectionLabel, SubTodoRows } from './TodoPageParts';

/** A description taller than this collapses behind "Show more" (J9). */
const DESCRIPTION_CLAMP_PX = 150;

/**
 * Markdown in the card, compact: headings near body size, short paragraph gaps, and images as
 * thumbnails no taller than 150 px that open in the split.
 */
const DESCRIPTION_MARKDOWN = cn(
  COMPACT_MARKDOWN,
  '!text-[13.5px] [&_img]:!my-1.5 [&_img]:block [&_img]:max-h-[140px] [&_img]:!max-w-[min(100%,260px)] [&_img]:cursor-zoom-in [&_img]:rounded-lg [&_img]:border [&_img]:border-border-secondary [&_img]:object-cover',
);

export interface TodoCardProps {
  detail: TodoDetail;
  onOpenTodo: (number: number) => void;
  onOpenImage: (src: string, label: string) => void;
}

/** The sub-to-dos section's element id, which the chip row's 1/2 scrolls to. */
export function todoSubTodosAnchor(number: number): string {
  return `todo-${number}-sub-todos`;
}

/** The card under the title: description, DONE WHEN and SUB-TO-DOS with + Add. */
export function TodoCard({ detail, onOpenTodo, onOpenImage }: TodoCardProps) {
  const { todo } = detail;
  const act = useTodosStore((state) => state.act);
  const isSub = todo.parentNumber !== null;
  return (
    <div className="mb-2 mt-3.5" data-testid="todo-card">
      {todo.summary.trim() ? <Description markdown={todo.summary} onOpenImage={onOpenImage} /> : <p className="text-[13px] text-text-tertiary">No description.</p>}
      {todo.doneWhen.length > 0 && (
        <>
          <SectionLabel>Done when · {todo.doneWhen.filter((item) => item.met).length} of {todo.doneWhen.length}</SectionLabel>
          <div className="flex flex-col gap-0.5" data-testid="todo-done-when">
            {todo.doneWhen.map((item, index) => (
              <button
                key={`${index}:${item.text}`}
                type="button"
                role="checkbox"
                aria-checked={item.met}
                onClick={() => void act({ kind: 'check', number: todo.number, index, met: !item.met })}
                className="flex items-start gap-2 rounded text-left text-[13px] text-text-primary"
                data-testid="todo-done-when-item"
              >
                <span className={cn('mt-[3px] flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px]', item.met ? 'border-status-success bg-status-success' : 'border-border-hover')}>
                  {item.met && <Check className="h-2.5 w-2.5 text-text-on-status-success" strokeWidth={3} aria-hidden="true" />}
                </span>
                <span>{item.text}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {(!isSub || detail.subTodos.length > 0) && <SubTodos detail={detail} onOpenTodo={onOpenTodo} canAdd={!isSub} />}
    </div>
  );
}

function SubTodos({ detail, onOpenTodo, canAdd }: { detail: TodoDetail; onOpenTodo: (number: number) => void; canAdd: boolean }) {
  const create = useTodosStore((state) => state.create);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    const made = await create({ title: text, parentNumber: detail.todo.number, startNow: true });
    setBusy(false);
    if (made) {
      setTitle('');
      setAdding(false);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      // Esc here cancels the new row; it doesn't leave the page.
      event.preventDefault();
      event.stopPropagation();
      setAdding(false);
      setTitle('');
    }
  };
  const done = detail.subTodos.filter((row) => row.status.status === 'done').length;
  return (
    <section id={todoSubTodosAnchor(detail.todo.number)} aria-label="Sub-to-dos" className="scroll-mt-4" data-testid="todo-sub-todos">
      <SectionLabel action={canAdd && !adding ? <SectionAction label="Add" onClick={() => setAdding(true)} testId="todo-add-sub" /> : undefined}>
        Sub-to-dos{detail.subTodos.length > 0 ? ` · ${done} of ${detail.subTodos.length}` : ''}
      </SectionLabel>
      {detail.subTodos.length > 0 ? <SubTodoRows rows={detail.subTodos} onOpen={onOpenTodo} /> : !adding && <p className="text-[12.5px] text-text-tertiary">None yet.</p>}
      {adding && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-border-interactive px-2 py-1" data-testid="todo-add-sub-row">
          <span className="w-3.5 shrink-0" aria-hidden="true" />
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={onKey}
            disabled={busy}
            placeholder={`New sub-to-do of ${detail.todo.ref}: its orchestrator assigns it`}
            aria-label={`New sub-to-do of ${detail.todo.ref}`}
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <button type="button" onClick={() => { setAdding(false); setTitle(''); }} className="h-7 rounded-md px-2 text-[12.5px] text-text-secondary hover:bg-surface-hover">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={!title.trim() || busy} className="h-7 rounded-md bg-interactive px-2.5 text-[12.5px] font-medium text-text-on-interactive disabled:opacity-50">Add</button>
        </div>
      )}
    </section>
  );
}

/**
 * One image in a description. A web or data URL shows as is; a file path (a pasted screenshot is
 * saved as one and attached) is read through Pane, which serves files attached to a to-do.
 */
function DescriptionImage({ src, alt }: MarkdownImageProps) {
  const direct = !src || /^(https?:|data:)/i.test(src);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (direct || !src) return;
    let live = true;
    setLoaded(null);
    setFailed(false);
    void window.electronAPI.autopilot.readDoc(src)
      .then(doc => { if (!live) return; if (doc.kind === 'image') setLoaded(doc.dataUrl); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [direct, src]);
  const label = alt || 'image';
  if (failed) return <span className="text-[12px] text-text-tertiary">[{label} could not be opened]</span>;
  const shown = direct ? src : loaded;
  if (!shown) return <span className="inline-block h-[60px] w-[100px] animate-pulse rounded-lg bg-surface-secondary" aria-label={`Loading ${label}`} />;
  return <img src={shown} alt={alt} tabIndex={0} role="button" aria-label={`Open ${label} beside the to-do`} />;
}

/** The description as Markdown; over 150 px it collapses with "Show more". Clicking an image opens it in the split. */
function Description({ markdown, onOpenImage }: { markdown: string; onOpenImage: (src: string, label: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setTall(element.scrollHeight > DESCRIPTION_CLAMP_PX + 8);
    measure();
    // Images load after the first measure and change the height.
    const observer = new ResizeObserver(measure);
    const inner = element.firstElementChild;
    if (inner) observer.observe(inner);
    return () => observer.disconnect();
  }, [markdown]);
  // Images are thumbnails that open in the split, by click or by Enter once tabbed to.
  useLayoutEffect(() => {
    for (const image of ref.current?.querySelectorAll('img') ?? []) {
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-label', `Open ${image.alt || 'image'} beside the to-do`);
    }
  }, [markdown, expanded]);
  const openImage = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    event.preventDefault();
    onOpenImage(target.currentSrc || target.src, target.alt || 'Image');
  };
  const clamped = tall && !expanded;
  return (
    <div data-testid="todo-description" data-collapsed={clamped || undefined}>
      <div
        ref={ref}
        role="presentation"
        onClick={openImage}
        onKeyDown={(event) => { if (event.key === 'Enter') openImage(event); }}
        className={cn('relative', clamped && 'overflow-hidden')}
        style={clamped ? { maxHeight: DESCRIPTION_CLAMP_PX } : undefined}
      >
        <MarkdownPreview content={markdown} className={DESCRIPTION_MARKDOWN} image={DescriptionImage} />
        {clamped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-surface-primary" aria-hidden="true" />}
      </div>
      {tall && (
        <button type="button" onClick={() => setExpanded((open) => !open)} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-interactive-text hover:underline" data-testid="todo-description-toggle">
          {expanded ? 'Show less' : 'Show more'}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}
