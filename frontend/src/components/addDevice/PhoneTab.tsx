import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import type { PairingView } from '../../hooks/useRelayPairing';
import { cn } from '../../utils/cn';
import { QR_PAPER, QrCode, TestFlightLine } from './QrCode';

/** The code box and its caption keep this footprint in every state. */
const CODE_BOX = 'h-[200px] w-[200px]';

const STEPS = [
  "Point your phone's camera at the code.",
  "Tap the link. It opens the Pane app, or Pane in your phone's browser.",
  'Your phone shows up under Phones and glasses.',
];

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function CodeBox({ view, onRetry }: { view: PairingView; onRetry: () => void }) {
  if (view.step === 'code') {
    return <div className={cn(CODE_BOX, QR_PAPER)}><QrCode url={view.url} label="Pairing code" /></div>;
  }
  if (view.step === 'error') {
    return (
      <div className={cn(CODE_BOX, 'flex flex-col items-center justify-center gap-3 rounded-xl border border-border-secondary bg-surface-secondary p-4 text-center')}>
        <AlertCircle className="h-6 w-6 text-status-error" aria-hidden="true" />
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
      </div>
    );
  }
  return (
    <div role="status" className={cn(CODE_BOX, 'flex flex-col items-center justify-center gap-2 rounded-xl border border-border-secondary bg-surface-secondary p-4 text-center')}>
      <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" aria-hidden="true" />
      {view.step === 'renewing' ? (
        <>
          <span className="text-sm font-medium text-text-primary">Code expired</span>
          <span className="text-xs text-text-tertiary">Making a new one…</span>
        </>
      ) : (
        <span className="text-xs text-text-tertiary">Getting this computer ready…</span>
      )}
    </div>
  );
}

function caption(view: PairingView, renewed: boolean): string {
  if (view.step !== 'code') return 'Codes last 10 minutes';
  return renewed ? `New code · ${countdown(view.secondsLeft)}` : `Works once · ${countdown(view.secondsLeft)}`;
}

/** Add a device › Phone: a one-time code, good for 10 minutes, that a phone scans to reach this computer from any network. */
export function PhoneTab({ view, paired, renewed, onRetry }: { view: PairingView; paired: string | null; renewed: boolean; onRetry: () => void }) {
  let side: ReactNode;
  if (view.step === 'error') {
    side = (
      <div role="alert" className="space-y-1">
        <p className="text-sm font-medium text-text-primary">This computer can&apos;t be paired right now</p>
        <p className="text-sm text-text-secondary">{view.message}</p>
        <p className="text-xs text-text-tertiary">Check this computer&apos;s internet connection, then choose Try again.</p>
      </div>
    );
  } else {
    side = (
      <ol className="space-y-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm text-text-primary">
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-surface-secondary text-[11px] font-medium text-text-secondary" aria-hidden="true">
              {index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-5">
      {paired && (
        <div className="flex items-start gap-3 rounded-lg border border-status-success/30 bg-status-success/10 p-3" role="status">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-status-success" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">Paired with {paired}</p>
            <p className="text-xs text-text-secondary">It can reach this computer from any network. To pair another phone, scan the new code.</p>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="flex w-[200px] flex-none flex-col items-center gap-3 self-center sm:self-start">
          <CodeBox view={view} onRetry={onRetry} />
          <p className="flex h-5 items-center justify-center whitespace-nowrap text-xs tabular-nums text-text-tertiary" aria-live="off">
            {caption(view, renewed)}
          </p>
        </div>
        <div className="min-w-0 flex-1 space-y-5 pt-2">
          {side}
          <TestFlightLine />
        </div>
      </div>
    </div>
  );
}
