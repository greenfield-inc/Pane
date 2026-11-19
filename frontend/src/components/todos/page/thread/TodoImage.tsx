import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { todosApi } from '../../../../stores/todosStore';
import { cn } from '../../../../utils/cn';
import { Bone, LoadingStatus, Skeleton, SkeletonSwap } from '../../../ui/Skeleton';

/** What loading a to-do's image came to: its source to show, still loading, or failed. */
export interface TodoImageSource {
  src: string | null;
  failed: boolean;
}

/**
 * An image on a to-do (a description's, a comment's, an attachment's). A web or data URL shows as
 * is; a file path (a pasted screenshot is saved as one and attached) is read through Pane, which
 * serves files attached to a to-do, as a data URL (`readDoc`; the web app reads it inline).
 */
export function useTodoImageSource(path: string | undefined): TodoImageSource {
  const direct = !path || /^(https?:|data:)/iu.test(path);
  const [loaded, setLoaded] = useState<{ path: string; src: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (direct || !path) return;
    let live = true;
    const api = todosApi();
    if (!api) {
      setLoaded({ path, src: null, failed: true });
      return;
    }
    void api.readDoc(path)
      .then((doc) => { if (live) setLoaded(doc.kind === 'image' ? { path, src: doc.dataUrl, failed: false } : { path, src: null, failed: true }); })
      .catch(() => { if (live) setLoaded({ path, src: null, failed: true }); });
    return () => { live = false; };
  }, [direct, path]);
  if (direct) return { src: path ?? null, failed: !path };
  if (!loaded || loaded.path !== path) return { src: null, failed: false };
  return { src: loaded.src, failed: loaded.failed };
}

export interface TodoImageThumbProps {
  path: string;
  label: string;
  /** Opens the image's attachment tab in the split; without it the thumbnail is only a picture. */
  onOpen?: () => void;
  className?: string;
}

const THUMB_BOX = 'max-h-[160px] max-w-[min(100%,240px)] rounded-lg border border-border-secondary';

/**
 * A thumbnail in the thread (round 8, T-5): at most 240×160, rounded, with a border; a skeleton
 * while it loads; clicking it opens the image's attachment tab, shown big in the split.
 */
export function TodoImageThumb({ path, label, onOpen, className }: TodoImageThumbProps) {
  const { src, failed } = useTodoImageSource(path);
  if (failed) {
    return (
      <span className={cn('inline-flex h-[22px] items-center gap-[5px] rounded-md bg-surface-tertiary px-[7px] text-[11.5px] text-text-tertiary', className)} title={path} data-testid="todo-thread-image-failed">
        <ImageOff className="h-3 w-3" aria-hidden="true" />
        {label} could not be opened
      </span>
    );
  }
  const image = src && <img src={src} alt={label} className={cn(THUMB_BOX, 'block object-cover')} draggable={false} />;
  return (
    <SkeletonSwap loading={!src} skeleton={
      <>
        <LoadingStatus label={`Loading ${label}`} />
        <Skeleton className={cn('h-[120px] w-[180px] rounded-lg border border-border-secondary bg-surface-secondary', className)}>
          <Bone className="h-full w-full rounded-none" />
        </Skeleton>
      </>
    }>
      {onOpen ? (
        <button type="button" onClick={onOpen} aria-label={`Open ${label} beside the to-do`} title={label}
          className={cn('block cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-interactive', className)} data-testid="todo-thread-image" data-path={path}>
          {image}
        </button>
      ) : <span className={cn('block', className)} data-testid="todo-thread-image" data-path={path}>{image}</span>}
    </SkeletonSwap>
  );
}
