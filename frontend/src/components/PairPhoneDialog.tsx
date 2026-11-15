import { useMemo, type ReactNode } from 'react';
import { create as createQr } from 'qrcode';
import { AlertCircle, CheckCircle2, Clock, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { useRelayPairing, type PairingView } from '../hooks/useRelayPairing';
import { requestOpenSettings } from '../utils/openSettings';
import { cn } from '../utils/cn';

/** The code box and its caption keep this footprint in every state. */
const CODE_BOX = 'h-[200px] w-[200px]';

const STEPS = [
  "Open your phone's camera and point it at the code.",
  "Tap the link. It opens the Pane app, or Pane in your phone's browser.",
  'Your phone shows up in Settings › Remote Access, where you can remove it.',
];

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The pairing URL as a QR code, drawn as one SVG path. */
function QrCode({ url }: { url: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = createQr(url, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: modules.size, path: d };
  }, [url]);
  return (
    <svg
      role="img"
      aria-label="Pairing code"
      data-url={url}
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="h-full w-full [shape-rendering:crispEdges]"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

function CodeBox({ view, onRetry }: { view: PairingView; onRetry: () => void }) {
  // Cameras read dark modules on a light ground, so the code keeps these colors in every theme.
  const paper = 'rounded-xl border border-border-secondary bg-white p-2 text-black';
  let content: ReactNode;
  if (view.step === 'code') {
    content = <div className={cn(CODE_BOX, paper)}><QrCode url={view.url} /></div>;
  } else if (view.step === 'error') {
    content = (
      <div className={cn(CODE_BOX, 'flex flex-col items-center justify-center gap-3 rounded-xl border border-border-secondary bg-surface-secondary p-4 text-center')}>
        <AlertCircle className="h-6 w-6 text-status-error" aria-hidden="true" />
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
      </div>
    );
  } else {
    content = (
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
  return content;
}

function Caption({ view, renewed }: { view: PairingView; renewed: boolean }) {
  const text = view.step === 'code'
    ? renewed ? `New code · expires in ${countdown(view.secondsLeft)}` : `Expires in ${countdown(view.secondsLeft)} · works once`
    : 'Codes last 10 minutes';
  return (
    <p className="flex h-5 items-center justify-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-text-tertiary" aria-live="off">
      <Clock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      {text}
    </p>
  );
}

/**
 * "Pair a phone": a one-time code a phone scans to reach this computer from any network. Opening it
 * turns phone access on; a used or expired code is replaced at once.
 */
export function PairPhoneDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { view, paired, renewal, retry } = useRelayPairing(isOpen);

  const openTailscaleSetup = () => {
    onClose();
    requestOpenSettings({ category: 'remote-access', subview: 'host-setup' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" ariaLabel="Pair a phone">
      <div className="flex items-center gap-3 border-b border-border-primary px-6 py-4">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-surface-secondary text-text-secondary" aria-hidden="true">
          <Smartphone className="h-4 w-4" />
        </span>
        <h2 className="text-heading-2 text-text-primary">Pair a phone</h2>
      </div>
      <ModalBody className="space-y-5 py-5">
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
            <CodeBox view={view} onRetry={retry} />
            <Caption view={view} renewed={renewal !== null} />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            {view.step === 'error' ? (
              <div role="alert" className="space-y-1">
                <p className="text-sm font-medium text-text-primary">This computer can&apos;t be paired right now</p>
                <p className="text-sm text-text-secondary">{view.message}</p>
                <p className="text-xs text-text-tertiary">Check this computer&apos;s internet connection, then choose Try again.</p>
              </div>
            ) : !paired && (
              <p className="text-sm text-text-secondary">
                Watch and steer your agents from your phone, on any network. Terminals and dev server previews come with it.
              </p>
            )}
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
            <p className="flex gap-2 text-xs text-text-tertiary">
              <ShieldCheck className="mt-px h-3.5 w-3.5 flex-none" aria-hidden="true" />
              On the same Wi-Fi your phone connects directly. Anywhere else, Pane&apos;s servers carry the connection.
            </p>
          </div>
        </div>
      </ModalBody>
      <ModalFooter className="justify-between">
        <button type="button" className="text-sm text-text-secondary underline underline-offset-4 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle" onClick={openTailscaleSetup}>
          Use Tailscale instead
        </button>
        <Button type="button" variant="secondary" onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}
