import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../utils/cn';

/**
 * The workspace area. While a remote host is not connected it dims and turns
 * inert, so clicks and keys are visibly unavailable instead of silently dropped.
 * Children stay mounted; when it comes back, focus returns to whatever in the
 * workspace had it, unless the person has since focused something else.
 */
export function RemoteWorkspace({ dimmed, children }: { dimmed: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Turning inert blurs to <body> without a focusin, so the last workspace focus survives it.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      lastFocusedRef.current = target && ref.current?.contains(target) ? target : null;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useEffect(() => {
    if (dimmed) return;
    const target = lastFocusedRef.current;
    const active = document.activeElement;
    if (target?.isConnected && (!active || active === document.body)) target.focus({ preventScroll: true });
  }, [dimmed]);

  return (
    <div
      ref={ref}
      inert={dimmed}
      aria-busy={dimmed || undefined}
      className={cn('relative flex min-h-0 min-w-0 flex-1 transition-opacity duration-normal', dimmed && 'opacity-50')}
    >
      {children}
    </div>
  );
}
