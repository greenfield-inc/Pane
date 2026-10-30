import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Glasses } from 'lucide-react';
import { Button } from '../ui/Button';
import { settingDomId } from './catalog';
import { CARD_ROW } from './CodelessRemoteSettings';
import { API } from '../../utils/api';
import type { GlassesAccessState, GlassesRevokeEverywhereResult } from '../../../../shared/types/glasses';

/** The page lists newly refused origins while it is open, so allowing one needs no reload. */
const REFRESH_MS = 5_000;
const REVOKED_HERE = 'Revoked. These glasses stay off this computer until you pair them again from the Pane phone app.';
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
  /** What the last revoke did, kept after its row is gone; the poll never clears it. */
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  /** The phone whose revoke did not reach every computer, so it can be sent again after its row is gone. */
  const [retryPhoneId, setRetryPhoneId] = useState<string | null>(null);

  /** Shows the state a request answers, or its error; true when it succeeded. */
  const apply = useCallback(async (request: () => Promise<{ success: boolean; data?: GlassesAccessState; error?: string }>) => {
    const response = await request();
    if (response.success && response.data) {
      setState(response.data);
      setError(null);
      return true;
    }
    setError(response.error ?? 'Could not read glasses access.');
    return false;
  }, []);

  useEffect(() => {
    void apply(() => API.remoteDaemon.getGlasses());
    const timer = window.setInterval(() => void apply(() => API.remoteDaemon.getGlasses()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [apply]);

  const run = async (request: () => Promise<{ success: boolean; data?: GlassesAccessState; error?: string }>) => {
    setBusy(true);
    try {
      return await apply(request);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setNotice(null);
    if (await run(() => API.remoteDaemon.revokeGlasses(id))) setNotice({ text: REVOKED_HERE });
  };

  const revokeEverywhere = async (phoneId: string) => {
    setBusy(true);
    setNotice({ text: 'Revoking on your computers…' });
    try {
      const response = await API.remoteDaemon.revokeGlassesEverywhere(phoneId);
      await apply(() => API.remoteDaemon.getGlasses());
      if (response.success && response.data) {
        setNotice({ text: revokeEverywhereMessage(response.data) });
        setRetryPhoneId(response.data.notReached.length > 0 ? phoneId : null);
      } else {
        setNotice({ text: response.error ?? 'Could not revoke the glasses on your computers.', failed: true });
        setRetryPhoneId(phoneId);
      }
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
      {(notice || retryPhoneId) && (
        <div className={`flex items-center justify-between gap-3 ${CARD_ROW}`}>
          {notice && <p className={`text-sm ${notice.failed ? 'text-status-error' : 'text-text-secondary'}`} role="status">{notice.text}</p>}
          {retryPhoneId && (
            <Button type="button" variant="ghost" size="sm" className="flex-none" disabled={busy} onClick={() => void revokeEverywhere(retryPhoneId)}>
              Retry on my other computers
            </Button>
          )}
        </div>
      )}
      {devices.length === 0 && (
        <DeviceRow title="Even G2 glasses" detail="Pair from the Pane phone app: Settings › Glasses › Pair glasses." />
      )}
      {devices.map(({ phoneId, ...device }) => (
        <DeviceRow
          key={device.id}
          title={device.label}
          detail={device.lastUsedAt ? `Last used ${new Date(device.lastUsedAt).toLocaleString()}` : 'Never used'}
        >
          <div className="flex flex-none items-center gap-2">
            {phoneId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${device.label} on all my computers`}
                disabled={busy}
                onClick={() => void revokeEverywhere(phoneId)}
              >
                Revoke on all my computers
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Revoke ${device.label}`}
              disabled={busy}
              onClick={() => void revoke(device.id)}
            >
              Revoke
            </Button>
          </div>
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

/** Such as "Revoked on Mac, devbox. Not reached: laptop (offline); revoke there when it is back." */
function revokeEverywhereMessage({ revoked, notReached }: GlassesRevokeEverywhereResult): string {
  const done = `Revoked on ${revoked.join(', ')}.`;
  if (notReached.length === 0) return done;
  const missed = notReached.map((computer) => `${computer.name} (${computer.reason})`).join(', ');
  return `${done} Not reached: ${missed}; revoke there when ${notReached.length === 1 ? 'it is' : 'they are'} back.`;
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
