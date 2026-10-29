import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { SettingRow } from './SettingRow';
import { SegmentedControl } from './SettingsControls';
import { API } from '../../utils/api';
import {
  WORKSPACE_PASSWORD_MIN_LENGTH,
  type WorkspaceAccessSummary,
  type WorkspaceAccessUpdate,
  type WorkspaceVisibility,
} from '../../../../shared/types/workspaceAccess';

const VISIBILITY_OPTIONS: ReadonlyArray<{ id: WorkspaceVisibility; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'owner', label: 'Only me' },
  { id: 'tailnet', label: 'Everyone on tailnet' },
];

/** Card rows get the card's inset instead of a section's full width. */
export const CARD_ROW = 'px-4 py-3';

/**
 * Who may connect to this computer over Tailscale without a code (visibility, plus an
 * optional password), and the address a phone enters to find it.
 */
export function CodelessAccessRows({ tailnetName }: { tailnetName: string | null }) {
  const [access, setAccess] = useState<WorkspaceAccessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingVisibility, setPendingVisibility] = useState<WorkspaceVisibility | null>(null);
  const [passwordDraft, setPasswordDraft] = useState<string | null>(null);
  const mounted = useRef(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    mounted.current = true;
    void API.remoteDaemon.getWorkspaceAccess().then((response) => {
      if (!mounted.current) return;
      if (response.success && response.data) setAccess(response.data);
      else setError(response.error ?? 'Could not read who can connect to this machine.');
    }).catch((cause: unknown) => {
      if (mounted.current) setError(errorMessage(cause, 'Could not read who can connect to this machine.'));
    });
    return () => { mounted.current = false; };
  }, []);

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => { if (mounted.current) setCopied(false); }, 2_000);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not copy the address.'));
    }
  };

  const updateAccess = async (update: WorkspaceAccessUpdate): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await API.remoteDaemon.updateWorkspaceAccess(update);
      if (!response.success || !response.data) {
        setError(response.error ?? 'Could not change who can connect to this machine.');
        return false;
      }
      setAccess(response.data);
      return true;
    } catch (cause) {
      setError(errorMessage(cause, 'Could not change who can connect to this machine.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseVisibility = (visibility: WorkspaceVisibility) => {
    if (visibility === access?.visibility) return;
    // Widening to the whole tailnet always needs an explicit, warned confirmation.
    if (visibility === 'tailnet') {
      setPendingVisibility('tailnet');
      return;
    }
    setPendingVisibility(null);
    void updateAccess({ visibility });
  };

  const confirmTailnetVisibility = async () => {
    if (await updateAccess({ visibility: 'tailnet' })) setPendingVisibility(null);
  };

  const savePassword = async () => {
    if (passwordDraft !== null && await updateAccess({ password: passwordDraft })) setPasswordDraft(null);
  };

  const visibility = pendingVisibility ?? access?.visibility ?? 'owner';
  const passwordValid = passwordDraft !== null && passwordDraft.length >= WORKSPACE_PASSWORD_MIN_LENGTH;

  return (
    <>
      {error && (
        <div className={`flex items-start justify-between gap-3 bg-status-error/10 text-sm text-text-primary ${CARD_ROW}`} role="alert">
          <span>{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>
        </div>
      )}
      <SettingRow
        settingId="remote-visibility"
        label="Who can connect"
        description={describeAccess(access)}
        align="start"
        className={CARD_ROW}
      >
        <div className="w-full space-y-3 sm:w-[360px]">
          <SegmentedControl<WorkspaceVisibility>
            label="Who can connect to this computer"
            columns={3}
            value={visibility}
            options={VISIBILITY_OPTIONS}
            onChange={chooseVisibility}
          />
          {pendingVisibility === 'tailnet' && (
            <div className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-text-primary" role="alert">
              <p className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-status-warning" />
                Anyone on {tailnetName ?? 'this tailnet'} can connect
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                They can run agents and commands on this computer. Add a password to limit who gets in.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setPendingVisibility(null)}>Cancel</Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  loading={busy}
                  onClick={() => void confirmTailnetVisibility()}
                >
                  Allow Everyone
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingRow>
      <SettingRow
        settingId="remote-password"
        label="Password"
        description={access?.passwordProtected
          ? 'On. Every device enters it to connect.'
          : 'Off. Your own devices connect without one.'}
        align="start"
        className={CARD_ROW}
      >
        {passwordDraft === null ? (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={busy || access === null} onClick={() => setPasswordDraft('')}>
              {access?.passwordProtected ? 'Change' : 'Set Password'}
            </Button>
            {access?.passwordProtected && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void updateAccess({ password: null })}>
                Remove
              </Button>
            )}
          </div>
        ) : (
          <form
            className="w-full space-y-2 sm:w-[320px]"
            onSubmit={(event) => {
              event.preventDefault();
              if (passwordValid) void savePassword();
            }}
          >
            <Input
              type="password"
              label="Password"
              value={passwordDraft}
              onChange={(event) => setPasswordDraft(event.target.value)}
              error={passwordDraft && !passwordValid ? `At least ${WORKSPACE_PASSWORD_MIN_LENGTH} characters` : undefined}
              autoFocus
              fullWidth
              className="ph-no-capture"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setPasswordDraft(null)}>Cancel</Button>
              <Button type="submit" size="sm" loading={busy} disabled={!passwordValid}>Save</Button>
            </div>
          </form>
        )}
      </SettingRow>
      {access?.state === 'on' && access.url && access.visibility !== 'off' && (
        <SettingRow
          settingId="remote-address"
          label="Address"
          description="Enter it in Pane on your phone to find your computers."
          className={CARD_ROW}
        >
          <div className="flex items-center justify-end gap-2">
            <code className="truncate text-xs text-text-secondary">{phoneAddress(access.url)}</code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              onClick={() => void copyAddress(phoneAddress(access.url ?? ''))}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </SettingRow>
      )}
    </>
  );
}

function describeAccess(access: WorkspaceAccessSummary | null): string {
  if (!access) return 'Checking Tailscale…';
  if (access.state === 'off' && access.visibility !== 'off') return `${access.reason ?? 'Not running'}. ${access.fix ?? ''}`.trim();
  if (access.visibility === 'off') return 'Connection codes only.';
  return access.visibility === 'tailnet' ? 'Anyone on this tailnet.' : 'Your devices on Tailscale.';
}

/** What a phone needs to reach a computer: its Tailscale name, plus the port when not 8443. */
export function phoneAddress(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/:8443\/?$/, '');
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
