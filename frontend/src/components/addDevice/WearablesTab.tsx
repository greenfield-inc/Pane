import { cn } from '../../utils/cn';
import { QR_PAPER, QrCode, TestFlightLine } from './QrCode';

/** Add a device › Wearables: glasses pair through the phone app, so the code opens its Glasses screen. */
export function WearablesTab({ domain }: { domain: string }) {
  return (
    <div className="flex flex-col gap-6 sm:flex-row">
      <div className="flex w-[200px] flex-none flex-col items-center gap-3 self-center sm:self-start">
        <div className={cn('h-[200px] w-[200px]', QR_PAPER)}>
          <QrCode url={`https://${domain}/glasses`} label="Code that opens Pane's Glasses screen" />
        </div>
        <p className="text-xs text-text-tertiary">Opens Pane › Glasses</p>
      </div>
      <div className="min-w-0 flex-1 space-y-4 pt-2">
        <p className="text-sm text-text-primary">
          Glasses pair through the Pane app on your phone. Scan this with your phone&apos;s camera to open the glasses screen.
        </p>
        <p className="text-sm text-text-tertiary">
          Or open Pane on your phone:{' '}
          <span className="rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-xs text-text-primary">Settings › Glasses › Pair glasses</span>
        </p>
        <TestFlightLine />
      </div>
    </div>
  );
}
