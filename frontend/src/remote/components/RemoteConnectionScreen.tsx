import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Download, Monitor, Smartphone, Trash2 } from 'lucide-react';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';
import { isNativeMobile, openNativeExternalUrl } from '../runtime/nativeMobile';

type ConnectionScreenMode = 'menu' | 'connect';
type MobileInstallPlatform = 'ios' | 'android' | 'mobile';
export type RemoteConnectionErrorKind = 'connection-code' | 'connection';

interface RemoteConnectionScreenProps {
  savedProfiles: RemotePaneConnectionProfile[];
  error: string | null;
  errorKind: RemoteConnectionErrorKind | null;
  onConnectCode: (code: string) => Promise<void>;
  onConnectProfile: (profile: RemotePaneConnectionProfile) => Promise<void>;
  onForgetProfile: (profileId: string) => void;
}

export function RemoteConnectionScreen({
  savedProfiles,
  error,
  errorKind,
  onConnectCode,
  onConnectProfile,
  onForgetProfile,
}: RemoteConnectionScreenProps) {
  const [code, setCode] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [mode, setMode] = useState<ConnectionScreenMode>(() => (
    savedProfiles.length > 0 ? 'connect' : 'menu'
  ));
  const canReadClipboard = Boolean(navigator.clipboard?.readText);
  const mobileInstallPlatform = getMobileInstallPlatform();
  const connectionErrorId = useId();
  const showConnectionTroubleshooting = Boolean(error && errorKind === 'connection');

  useEffect(() => {
    if (savedProfiles.length > 0) {
      setMode('connect');
    }
  }, [savedProfiles.length]);

  const handleSubmit = async () => {
    let connectionCode = code.trim();
    if (!connectionCode && canReadClipboard) {
      try {
        connectionCode = (await navigator.clipboard.readText()).trim();
        setCode(connectionCode);
      } catch {
        setClipboardError('Clipboard access was blocked. Paste the connection code manually.');
        return;
      }
    }

    if (!connectionCode) return;

    setIsConnecting(true);
    setClipboardError(null);
    try {
      await onConnectCode(connectionCode);
      setCode('');
    } catch {
      // The parent owns the visible error state.
    } finally {
      setIsConnecting(false);
    }
  };

  const submitConnectionCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSubmit();
  };

  const handleProfileConnect = async (profile: RemotePaneConnectionProfile) => {
    setIsConnecting(true);
    setConnectingProfileId(profile.id);
    setClipboardError(null);
    try {
      await onConnectProfile(profile);
    } catch {
      // The parent owns the visible error state.
    } finally {
      setIsConnecting(false);
      setConnectingProfileId(null);
    }
  };

  const showFirstRunMenu = savedProfiles.length === 0 && mode === 'menu';
  const showBackToMenu = savedProfiles.length === 0 && mode === 'connect';

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-bg-primary px-4 py-6 text-text-primary sm:p-6">
      <section className="w-full max-w-sm sm:max-w-2xl">
        <div className="mb-6 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-secondary text-interactive">
            <Monitor className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text-primary">Remote Pane</h1>
            <p className="text-sm text-text-secondary">Connect to a Pane host from desktop or mobile.</p>
          </div>
        </div>

        {showFirstRunMenu && error && (
          <p role="alert" className="mb-4 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-text-primary">{error}</p>
        )}
        {showFirstRunMenu ? (
          <div className="space-y-4">
            {mobileInstallPlatform && !isNativeMobile() && (
              <MobileInstallPrompt platform={mobileInstallPlatform} />
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMode('connect')}
                className="group flex min-h-36 flex-col items-start justify-between rounded-lg border border-border-primary bg-surface-primary p-4 text-left shadow-lg transition-colors hover:border-border-focus hover:bg-surface-hover"
              >
                <div>
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-surface-secondary text-interactive">
                    <ClipboardPaste className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h2 className="text-base font-semibold text-text-primary">Connect with a code</h2>
                  <p className="mt-2 text-sm leading-5 text-text-secondary">Paste a pane-remote:// code from an existing remote host.</p>
                </div>
                <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-interactive">
                  Open connection form
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </button>

              <a
                href="https://runpane.com/docs/remote-daemon"
                target="_blank"
                rel="noreferrer"
                onClick={event => {
                  if (!isNativeMobile()) return;
                  event.preventDefault();
                  void openNativeExternalUrl('https://runpane.com/docs/remote-daemon');
                }}
                className="group flex min-h-36 flex-col items-start justify-between rounded-lg border border-border-primary bg-surface-primary p-4 text-left shadow-lg transition-colors hover:border-border-focus hover:bg-surface-hover"
              >
                <div>
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-surface-secondary text-interactive">
                    <BookOpen className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h2 className="text-base font-semibold text-text-primary">Set up a remote host</h2>
                  <p className="mt-2 text-sm leading-5 text-text-secondary">Run Pane on a VM, WSL box, server, or desktop and create a connection code.</p>
                </div>
                <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-interactive">
                  Open setup guide
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </a>
            </div>
          </div>
        ) : (
          <form
            onSubmit={submitConnectionCode}
            aria-busy={isConnecting}
            className="rounded-lg border border-border-primary bg-surface-primary p-5 shadow-lg sm:p-6"
          >
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {isConnecting ? connectingProfileId ? 'Connecting to saved profile' : 'Connecting to remote Pane' : ''}
            </div>
            {showBackToMenu && (
              <button
                type="button"
                onClick={() => setMode('menu')}
                className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </button>
            )}

            <label className="mb-2 block text-sm font-medium text-text-secondary" htmlFor="connection-code">
              Connection Code
            </label>
            <textarea
              id="connection-code"
              value={code}
              onChange={event => setCode(event.target.value)}
              aria-invalid={Boolean(error || clipboardError)}
              aria-describedby={error || clipboardError ? connectionErrorId : undefined}
              placeholder="pane-remote://..."
              className="ph-no-capture min-h-32 max-h-52 w-full resize-y rounded-md border border-border-primary bg-bg-secondary p-3 font-mono text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-focus"
            />

            {(error || clipboardError) && (
              <div id={connectionErrorId} role="alert" className="mt-3 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-text-primary">
                <p>{error || clipboardError}</p>
                {showConnectionTroubleshooting && (
                  <p className="mt-2 text-xs text-text-primary">
                    If this profile uses Tailscale, install or open Tailscale on this device, sign in to the same tailnet as the host, then retry.
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 flex justify-stretch sm:justify-end">
              <button
                type="submit"
                disabled={isConnecting || (!code.trim() && !canReadClipboard)}
                aria-busy={isConnecting && connectingProfileId === null}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-interactive px-4 py-2.5 text-sm font-semibold text-text-on-interactive transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:py-2"
              >
                {code.trim() ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : <ClipboardPaste className="h-4 w-4" aria-hidden="true" />}
                {isConnecting ? 'Connecting...' : code.trim() ? 'Import & Connect' : 'Paste & Connect'}
              </button>
            </div>

            {savedProfiles.length > 0 && (
              <div className="mt-7 border-t border-border-primary pt-5">
                <h2 className="mb-3 text-sm font-semibold text-text-secondary">Saved profiles</h2>
                <div className="space-y-2">
                  {savedProfiles.map(profile => (
                    <div key={profile.id} className="flex flex-col gap-3 rounded-md border border-border-primary bg-surface-secondary px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{profile.label}</p>
                        <p className="truncate text-xs text-text-tertiary">{profile.baseUrl}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { void handleProfileConnect(profile); }}
                          disabled={isConnecting}
                          aria-busy={connectingProfileId === profile.id}
                          className="min-w-0 flex-1 rounded-md bg-interactive px-3 py-2 text-sm font-semibold text-text-on-interactive hover:opacity-90 sm:flex-none sm:py-1.5"
                        >
                          Connect
                        </button>
                        <button
                          type="button"
                          onClick={() => onForgetProfile(profile.id)}
                          disabled={isConnecting}
                          className="rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                          aria-label={`Forget ${profile.label}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </form>
        )}
      </section>
    </main>
  );
}

function MobileInstallPrompt({ platform }: { platform: MobileInstallPlatform }) {
  const steps = getMobileInstallSteps(platform);

  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary p-4 shadow-lg">
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-secondary text-interactive">
          <Smartphone className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">Install Remote Pane</h2>
            <Download className="h-4 w-4 text-interactive" aria-hidden="true" />
          </div>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm leading-5 text-text-secondary">
            {steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function getMobileInstallSteps(platform: MobileInstallPlatform): string[] {
  if (platform === 'ios') {
    return [
      'Open this page in Safari.',
      'Tap Share.',
      'Tap Add to Home Screen.',
    ];
  }

  if (platform === 'android') {
    return [
      'Open this page in Chrome.',
      'Open the browser menu.',
      'Tap Install app or Add to Home screen.',
    ];
  }

  return [
    'Open this page in your mobile browser.',
    'Use the browser menu or share sheet.',
    'Choose the home-screen install option.',
  ];
}

function getMobileInstallPlatform(): MobileInstallPlatform | null {
  // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true;
  if (isStandalone) {
    return null;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const touchMac = /macintosh/.test(userAgent) && navigator.maxTouchPoints > 1;
  if (/iphone|ipad|ipod/.test(userAgent) || touchMac) {
    return 'ios';
  }

  if (/android/.test(userAgent)) {
    return 'android';
  }

  const isNarrowTouch = window.matchMedia('(max-width: 767px)').matches && navigator.maxTouchPoints > 0;
  return isNarrowTouch ? 'mobile' : null;
}
