import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

interface RemoteGroupProps {
  title: string;
  /** Muted words after the title, such as "on studio-mac". */
  scope?: string;
  /** Shown at the right of the title row. */
  aside?: ReactNode;
  /** A line under the card. */
  footnote?: string;
  className?: string;
  children: ReactNode;
}

/** A titled card of rows, as Remote Access and Machine details lay them out. */
export function RemoteGroup({ title, scope, aside, footnote, className, children }: RemoteGroupProps) {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex min-h-6 items-center justify-between gap-3 px-0.5">
        <h3 className="min-w-0 truncate text-sm font-semibold text-text-primary">
          {title}
          {scope && <span className="ml-2 text-xs font-normal text-text-tertiary">{scope}</span>}
        </h3>
        {aside}
      </div>
      <div className="divide-y divide-border-secondary overflow-hidden rounded-lg border border-border-secondary bg-surface-primary">
        {children}
      </div>
      {footnote && <p className="px-0.5 text-xs text-text-tertiary">{footnote}</p>}
    </section>
  );
}
