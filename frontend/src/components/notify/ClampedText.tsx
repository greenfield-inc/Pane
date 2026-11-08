import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../utils/cn';

/**
 * A card's context: its line breaks kept, three lines at most until Show more, so the question
 * and its answers stay in view. The toggle shows only when the text is clamped.
 */
export function ClampedText({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    // A narrower column (Approvals beside a Pane, a window resize) can clamp text that fit before.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <div className={className} data-testid={testId}>
      <div ref={ref} className={cn('whitespace-pre-line break-words', !open && 'line-clamp-3')}>{text}</div>
      {(clamped || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-[12.5px] font-medium text-text-secondary hover:text-text-primary">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
