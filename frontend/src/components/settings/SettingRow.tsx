import type { ReactNode } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';
import type { SettingSaveState, SettingsSettingId } from '../../types/settings';
import { settingDomId } from './catalog';

interface SettingRowProps {
  settingId: SettingsSettingId;
  label: string;
  description?: string;
  /** Live state shown under the description, such as a status line. */
  status?: ReactNode;
  children: ReactNode;
  saveState?: SettingSaveState;
  disabled?: boolean;
  className?: string;
  align?: 'center' | 'start';
}
export function SettingRow({
  settingId,
  label,
  description,
  status,
  children,
  saveState = { state: 'idle' },
  disabled = false,
  className,
  align = 'center',
}: SettingRowProps) {
  return (
    <div
      id={settingDomId(settingId)}
      data-setting-id={settingId}
      tabIndex={-1}
      className={cn(
        'grid gap-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-subtle sm:grid-cols-[minmax(0,1fr)_minmax(180px,auto)]',
        align === 'center' ? 'sm:items-center' : 'sm:items-start',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        {description && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-tertiary">{description}</p>}
        {status && <div className="mt-2">{status}</div>}
        <SaveState state={saveState} />
      </div>
      <div className="min-w-0 sm:justify-self-end">{children}</div>
    </div>
  );
}

function SaveState({ state }: { state: SettingSaveState }) {
  if (state.state === 'idle') return null;
  if (state.state === 'saving') {
    return (
      <span className="mt-1.5 inline-flex items-center gap-1 text-xs text-text-tertiary" aria-live="polite">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving
      </span>
    );
  }
  if (state.state === 'saved') {
    return (
      <span className="mt-1.5 inline-flex items-center gap-1 text-xs text-status-success" aria-live="polite">
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }
  return (
    <span className="mt-1.5 flex items-start gap-1 text-xs text-status-error" role="alert">
      <AlertCircle className="mt-0.5 h-3 w-3 flex-none" /> {state.message}
    </span>
  );
}

interface SettingsPageProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SettingsPage({ title, description, children }: SettingsPageProps) {
  return (
    <section className="mx-auto w-full max-w-3xl pb-8">
      <header className="mb-7">
        <h2 className="text-xl font-semibold text-text-primary">{title}</h2>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-text-tertiary">{description}</p>}
      </header>
      <div className="space-y-8">{children}</div>
    </section>
  );
}
