import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Glasses } from 'lucide-react';
import { Button } from '../ui/Button';
import { settingDomId } from './catalog';
import { CARD_ROW } from './CodelessRemoteSettings';
import { API } from '../../utils/api';
import type { GlassesAccessState } from '../../../../shared/types/glasses';

/** The page lists newly refused origins while it is open, so allowing one needs no reload. */
const REFRESH_MS = 5_000;
/** The host keeps a loopback origin without its port and matches it on any port. */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])$/;

/**
 * Even G2 glasses paired with this computer through the Pane phone app, and the Even app
 * origins this computer accepts for them. Allowing an origin is a deliberate owner step on
 * this computer: the list shows what was refused, exactly as the browser sent it.
 */
export function GlassesRows() {
  const [state, setState] = useState<GlassesAccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(async (request: () => Promise<{ success: boolean; data?: GlassesAccessState; error?: string }>) => {
    const response = await request();
    if (response.success && response.data) {
      setState(response.data);
      setError(null);
    } else {
      setError(response.error ?? 'Could not read glasses access.');
    }
  }, []);

  useEffect(() => {
    void apply(() => API.remoteDaemon.getGlasses());
    const timer = window.setInterval(() => void apply(() => API.remoteDaemon.getGlasses()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [apply]);

  const run = async (request: () => Promise<{ success: boolean; data?: GlassesAccessState; error?: string }>) => {
    setBusy(true);
    try {
      await apply(request);
    } finally {
      setBusy(false);
    }
  };

  const devices = state?.devices ?? [];
  const ownerOrigins = state?.allowedOrigins.filter((entry) => entry.source === 'owner') ?? [];
  const refused = state?.refusedOrigins ?? [];

  return (
    <div id={settingDomId('remote-glasses')} data-setting-id="remote-glasses" tabIndex={-1} className="divide-y divide-border-secondary outline-none">
      {error && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{error}</p>}
      {devices.length === 0 && (
        <DeviceRow title="Even G2 glasses" detail="Pair from the Pane phone app: Settings › Glasses › Pair glasses." />
      )}
      {devices.map((device) => (
        <DeviceRow
          key={device.id}
          title={device.label}
          detail={device.lastUsedAt ? `Last used ${new Date(device.lastUsedAt).toLocaleString()}` : 'Never used'}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Revoke ${device.label}`}
            disabled={busy}
            onClick={() => void run(() => API.remoteDaemon.revokeGlasses(device.id))}
          >
            Revoke
          </Button>
        </DeviceRow>
      ))}
      {refused.map((entry) => (
        <DeviceRow
          key={entry.origin}
          title={<code>{entry.origin}</code>}
          detail={`Refused ${new Date(entry.at).toLocaleTimeString()}. Allow it only if this is the Even app on your phone.`}
        >
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => API.remoteDaemon.setGlassesOrigin({ origin: entry.origin, allowed: true }))}>
            Allow
          </Button>
        </DeviceRow>
      ))}
      {ownerOrigins.map((entry) => (
        <DeviceRow
          key={entry.origin}
          title={<code>{entry.origin}</code>}
          detail={LOOPBACK_ORIGIN.test(entry.origin) ? 'Allowed for glasses on this computer, on any port.' : 'Allowed for glasses on this computer.'}
        >
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => API.remoteDaemon.setGlassesOrigin({ origin: entry.origin, allowed: false }))}>
            Remove
          </Button>
        </DeviceRow>
      ))}
    </div>
  );
}

function DeviceRow({ title, detail, children }: { title: ReactNode; detail: string; children?: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${CARD_ROW}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-secondary text-text-secondary" aria-hidden="true">
          <Glasses className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{title}</p>
          <p className="text-xs text-text-tertiary">{detail}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
