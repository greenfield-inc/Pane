import { useMemo } from 'react';
import { create as createQr } from 'qrcode';
import { Button } from '../ui/Button';

/** The spec's quiet zone: phone cameras find a code faster with 4 blank modules around it. */
const QUIET_ZONE = 4;

/**
 * A URL as a QR code, drawn as one SVG path. Level L: a code on a screen isn't scuffed or folded,
 * and the lower level keeps a pairing link (about 120 bytes) at version 6 instead of 7, so each
 * module is bigger and a phone reads it on a 1x monitor.
 */
export function QrCode({ url, label }: { url: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = createQr(url, { errorCorrectionLevel: 'L' });
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
      aria-label={label}
      data-url={url}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${size + QUIET_ZONE * 2} ${size + QUIET_ZONE * 2}`}
      className="h-full w-full [shape-rendering:crispEdges]"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

/** Cameras read dark modules on a light ground, so a code keeps these colors in every theme. The quiet zone is in the code itself. */
export const QR_PAPER = 'rounded-xl border border-border-secondary bg-white text-black';

/** A code's box, and the width of the column it sits in: big enough that a phone reads a pairing link on a 1x monitor. */
export const QR_BOX = 'h-[264px] w-[264px]';
export const QR_COLUMN = 'w-[264px]';

/** For EU stores, under every App Store line here; remove it, and `EU_LINE` in `relay/src/api.rs`, when the app is on those stores. */
function TestFlightLine() {
  return (
    <p className="px-4 text-xs text-text-tertiary">
      In the EU?{' '}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-text-primary"
        onClick={() => void window.electronAPI.openExternal('https://testflight.apple.com/join/eKJmnzXF')}
      >
        Get it on TestFlight
      </button>{' '}
      for now.
    </p>
  );
}

/** No country in the path, so people reach their own App Store. */
const APP_STORE_URL = 'https://apps.apple.com/app/id6808839038';

export function AppStoreLine() {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-secondary px-4 py-3 text-sm text-text-secondary">
        <span className="min-w-0">No Pane app yet? The iPhone app is on the App Store.</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="flex-none"
          onClick={() => void window.electronAPI.openExternal(APP_STORE_URL)}
        >
          Open App Store
        </Button>
      </div>
      <TestFlightLine />
    </div>
  );
}
