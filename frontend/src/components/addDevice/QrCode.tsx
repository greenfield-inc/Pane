import { useMemo } from 'react';
import { create as createQr } from 'qrcode';
import { Button } from '../ui/Button';
import { DISCORD_INVITE_URL, DiscordIcon } from '../DiscordIcon';

/** A URL as a QR code, drawn as one SVG path. */
export function QrCode({ url, label }: { url: string; label: string }) {
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
      aria-label={label}
      data-url={url}
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="h-full w-full [shape-rendering:crispEdges]"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

/** Cameras read dark modules on a light ground, so a code keeps these colors in every theme. */
export const QR_PAPER = 'rounded-xl border border-border-secondary bg-white p-2 text-black';

/** D-46: the iPhone app is in TestFlight; Discord is where people ask to join. */
export function TestFlightLine() {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-secondary px-4 py-3 text-sm text-text-secondary">
      <span className="min-w-0">No Pane app yet? It&apos;s in TestFlight.</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="flex-none"
        icon={<DiscordIcon className="h-3.5 w-3.5 text-discord" />}
        onClick={() => void window.electronAPI.openExternal(DISCORD_INVITE_URL)}
      >
        Ask to join on Discord
      </Button>
    </div>
  );
}
