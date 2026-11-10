import { AlertCircle } from 'lucide-react';
import { SWITCH_TO_CHAT_CONFIRMATION, type SwitchFailure } from './switchToChatCopy';

/** The dialog's body: the confirmation, then progress or the failure. */
export function SwitchToChatBody({ busy, failure }: { busy: boolean; failure?: SwitchFailure }) {
  return <>
    <p className="text-sm text-text-secondary">{SWITCH_TO_CHAT_CONFIRMATION}</p>
    {busy && <p role="status" className="mt-3 text-sm text-text-tertiary">Switching…</p>}
    {failure?.title
      ? <div role="alert" className="mt-4 flex gap-3 rounded-lg border border-status-error/30 bg-status-error/10 p-3 text-sm">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-status-error" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold text-text-primary">{failure.title}</p>
          <p className="mt-1 text-text-secondary">{failure.message}</p>
        </div>
      </div>
      : failure && <p role="alert" className="mt-3 text-sm text-status-error">{failure.message}</p>}
  </>;
}
