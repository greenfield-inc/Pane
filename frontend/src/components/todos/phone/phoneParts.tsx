import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '../../../utils/cn';

interface PhoneBack {
  /** "To-dos", "T-12", "Cancel". */
  label: string;
  onBack: () => void;
}

export interface PhoneHeaderProps {
  title: ReactNode;
  back?: PhoneBack;
  /** What sits left when there is no back (the list's menu button). */
  lead?: ReactNode;
  right?: ReactNode;
  testId?: string;
}

/**
 * A phone screen's header (D-422): back on the left ("‹ To-dos"), the title centred, one action on
 * the right. It sits under the notch and the Dynamic Island, and clear of the rounded corners in
 * landscape.
 */
export function PhoneHeader({ title, back, lead, right, testId }: PhoneHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border-primary bg-bg-primary pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]" data-testid={testId}>
      <div className="flex h-12 items-center gap-1 px-2">
        <span className="flex min-w-16 shrink-0 items-center">
          {back ? (
            <button type="button" onClick={back.onBack} className="inline-flex h-11 max-w-[8.5rem] items-center gap-0.5 rounded-md pl-1 pr-2 text-[15px] text-interactive-text outline-none focus-visible:ring-2 focus-visible:ring-interactive" data-testid="phone-back">
              <ChevronLeft className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="truncate">{back.label}</span>
            </button>
          ) : lead}
        </span>
        <h1 className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-text-primary" data-testid="phone-title">{title}</h1>
        <span className="flex min-w-16 shrink-0 items-center justify-end">{right}</span>
      </div>
    </div>
  );
}

/** A 44 px square icon button for a phone header: the size a thumb hits. */
export const PHONE_ICON_BUTTON = 'inline-flex h-11 w-11 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-40';

/** The phone screens' scrolling body: momentum scrolling, never sideways. */
export const PHONE_SCROLL = 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain';

/** Side padding that clears the rounded corners and the notch in landscape. */
export const PHONE_SIDES = 'pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]';

/**
 * How far the on-screen keyboard covers the bottom of the page. Safari on an iPhone keeps the page's
 * height and shrinks only the visual viewport; with `interactive-widget=resizes-content` (Chrome) the
 * page itself shrinks and this stays 0.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/** Where each phone screen was scrolled to, so back returns to the same place (R23, R24). */
const scrollMemory = new Map<string, number>();

export function rememberScroll(key: string, top: number): void {
  scrollMemory.set(key, top);
}

export function recalledScroll(key: string): number {
  return scrollMemory.get(key) ?? 0;
}

export function PhoneScreen({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <div className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary text-text-primary', className)} data-testid={testId}>{children}</div>;
}
