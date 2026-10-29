import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { SettingsSection } from '../ui/SettingsSection';
import { SettingRow } from './SettingRow';
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
export function GlassesSettings() {
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
    <SettingsSection title="Glasses">
      <SettingRow
        settingId="remote-glasses"
        label="Even G2 glasses"
        description={devices.length === 0
          ? 'Pair from the Pane phone app: Settings › Glasses › Pair glasses.'
          : 'Glasses can list Panes, read and type into terminals, dictate and answer Notify.'}
        align="start"
      >
        {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
      </SettingRow>
      {devices.map((device) => (
        <div key={device.id} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{device.label}</p>
            <p className="text-xs text-text-tertiary">{device.lastUsedAt ? `Last used ${new Date(device.lastUsedAt).toLocaleString()}` : 'Never used'}</p>
          </div>
          <IconButton
            type="button"
            variant="danger"
            size="sm"
            aria-label={`Revoke ${device.label}`}
            icon={<Trash2 className="h-4 w-4" />}
            disabled={busy}
            onClick={() => void run(() => API.remoteDaemon.revokeGlasses(device.id))}
          />
        </div>
      ))}
      {refused.map((entry) => (
        <div key={entry.origin} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary"><code>{entry.origin}</code></p>
            <p className="text-xs text-text-tertiary">Refused {new Date(entry.at).toLocaleTimeString()}. Allow it only if this is the Even app on your phone.</p>
          </div>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => API.remoteDaemon.setGlassesOrigin({ origin: entry.origin, allowed: true }))}>
            Allow
          </Button>
        </div>
      ))}
      {ownerOrigins.map((entry) => (
        <div key={entry.origin} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary"><code>{entry.origin}</code></p>
            <p className="text-xs text-text-tertiary">{LOOPBACK_ORIGIN.test(entry.origin) ? 'Allowed for glasses on this computer, on any port.' : 'Allowed for glasses on this computer.'}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => API.remoteDaemon.setGlassesOrigin({ origin: entry.origin, allowed: false }))}>
            Remove
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}
