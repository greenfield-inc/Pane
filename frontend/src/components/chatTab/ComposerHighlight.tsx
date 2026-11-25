import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ComposerMark } from '../../../../shared/composerMentions';

/**
 * Paints the marks of a text box behind it, as the same text in the same shape. The box itself
 * stays a plain text area. Its parent is positioned, and the box's background is transparent.
 */
export function ComposerHighlight({ input, text, marks, className }: { input: RefObject<HTMLTextAreaElement | null>; text: string; marks: readonly ComposerMark[]; className: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const shown = marks.length > 0;
  useLayoutEffect(() => {
    const box = input.current;
    if (!box || !shown) return undefined;
    const follow = () => {
      const element = layer.current;
      if (!element) return;
      // The box's own scrollbar narrows its text, so the layer takes the inner size.
      element.style.width = `${box.clientWidth}px`;
      element.style.height = `${box.clientHeight}px`;
      element.scrollTop = box.scrollTop;
    };
    follow();
    const resized = new ResizeObserver(follow);
    resized.observe(box);
    box.addEventListener('scroll', follow);
    return () => { resized.disconnect(); box.removeEventListener('scroll', follow); };
  }, [input, shown, text]);
  if (!shown) return null;
  let at = 0;
  const parts = marks.flatMap(({ start, end }) => {
    const plain = text.slice(at, start);
    at = end;
    return [plain, <mark key={start} className="chat-mark">{text.slice(start, end)}</mark>];
  });
  // A last line that is empty takes its height from the zero-width space.
  return <div ref={layer} className={`${className} chat-input-highlight`} aria-hidden>{parts}{`${text.slice(at)}\u200b`}</div>;
}
