import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Clipboard, Download, ExternalLink, Loader2, Terminal } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isMac } from '../utils/platformUtils';
import { LiveRegion } from './ui/LiveRegion';
import type { UpdateCapabilities } from '../../../shared/types/updater';

interface UpdateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  versionInfo?: {
    current: string;
    latest: string;
    hasUpdate: boolean;
    releaseUrl?: string;
    downloadUrl?: string;
    releaseNotes?: string;
  };
}

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';

interface DownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export function UpdateDialog({ isOpen, onClose, versionInfo }: UpdateDialogProps) {
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPackaged, setIsPackaged] = useState(false);
  const [updateCapabilities, setUpdateCapabilities] = useState<UpdateCapabilities | null>(null);
  const userStartedUpdateRef = useRef(false);
  const downloadStartedRef = useRef(false);
  const installStartedRef = useRef(false);
  const installTimeoutRef = useRef<number | null>(null);

  const clearInstallTimeout = useCallback(() => {
    if (installTimeoutRef.current) {
      window.clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }
  }, []);

  // Reset internal state whenever the dialog opens so stale error/progress state
  // from a previous attempt doesn't persist across opens
  useEffect(() => {
    if (isOpen) {
      setUpdateState('idle');
      setDownloadProgress(null);
      setError(null);
      setMessage(null);
      userStartedUpdateRef.current = false;
      downloadStartedRef.current = false;
      installStartedRef.current = false;
      clearInstallTimeout();
    }
  }, [clearInstallTimeout, isOpen]);

  useEffect(() => clearInstallTimeout, [clearInstallTimeout]);

  useEffect(() => {
    // Check if app is packaged (auto-update only works in packaged apps)
    if (window.electronAPI?.isPackaged) {
      window.electronAPI.isPackaged().then((packaged) => {
        setIsPackaged(packaged);
      });
    }
    if (window.electronAPI?.updater?.getCapabilities) {
      window.electronAPI.updater.getCapabilities().then((response) => {
        if (response.success && response.data) {
          setUpdateCapabilities(response.data);
        } else {
          setUpdateCapabilities({ mode: 'manual', reason: 'untrusted-signature' });
        }
      }).catch(() => {
        setUpdateCapabilities({ mode: 'manual', reason: 'untrusted-signature' });
      });
    }
  }, []);

  const canUseSeamlessUpdater = !isMac() || updateCapabilities?.mode === 'seamless';
  const isResolvingUpdateMode = isMac() && updateCapabilities === null;

  const startDownloadUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      setUpdateState('error');
      return;
    }
    if (downloadStartedRef.current) return;

    try {
      downloadStartedRef.current = true;
      setError(null);
      setMessage(null);
      setUpdateState('downloading');
      const response = await window.electronAPI.updater.downloadUpdate();
      if (!response.success) {
        throw new Error(response.error || 'Failed to download update');
      }
    } catch (err: unknown) {
      downloadStartedRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to download update');
      setUpdateState('error');
    }
  }, []);

  const installDownloadedUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      setUpdateState('error');
      return;
    }
    if (installStartedRef.current) return;

    try {
      installStartedRef.current = true;
      clearInstallTimeout();
      setError(null);
      setMessage(null);
      setUpdateState('installing');
      const response = await window.electronAPI.updater.installUpdate();
      if (!response.success) {
        throw new Error(response.error || 'Failed to install update');
      }
      installTimeoutRef.current = window.setTimeout(() => {
        userStartedUpdateRef.current = false;
        installStartedRef.current = false;
        setError('Pane did not restart after starting the installer. Download the latest release manually and run the installer.');
        setUpdateState('error');
      }, 15000);
    } catch (err: unknown) {
      installStartedRef.current = false;
      clearInstallTimeout();
      setError(err instanceof Error ? err.message : 'Failed to install update');
      setUpdateState('error');
    }
  }, [clearInstallTimeout]);

  useEffect(() => {
    if (!isOpen || !window.electronAPI?.events) return;

    // Set up auto-updater event listeners
    const cleanupFns: Array<() => void> = [];

    cleanupFns.push(
      window.electronAPI.events.onUpdaterCheckingForUpdate(() => {
        setUpdateState('checking');
        setError(null);
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterUpdateAvailable(() => {
        setUpdateState('available');
        if (userStartedUpdateRef.current && canUseSeamlessUpdater) {
          void startDownloadUpdate();
        }
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterUpdateNotAvailable(() => {
        userStartedUpdateRef.current = false;
        setUpdateState('idle');
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterDownloadProgress((progress) => {
        setUpdateState('downloading');
        setDownloadProgress(progress);
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterUpdateDownloaded(() => {
        setUpdateState('downloaded');
        setDownloadProgress(null);
        // macOS presents an explicit restart prompt; preserve the existing
        // automatic install behavior on other platforms.
        if (userStartedUpdateRef.current && !isMac()) {
          void installDownloadedUpdate();
        }
      })
    );

    cleanupFns.push(
      window.electronAPI.events.onUpdaterError((err) => {
        console.error('Update error:', err);
        userStartedUpdateRef.current = false;
        downloadStartedRef.current = false;
        installStartedRef.current = false;
        clearInstallTimeout();
        setUpdateState('error');
        setError(err.message || 'An unknown error occurred');
      })
    );

    return () => {
      cleanupFns.forEach(fn => fn());
    };
  }, [canUseSeamlessUpdater, clearInstallTimeout, installDownloadedUpdate, isOpen, startDownloadUpdate]);

  const handleStartUpdate = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }

    try {
      userStartedUpdateRef.current = true;
      downloadStartedRef.current = false;
      installStartedRef.current = false;
      clearInstallTimeout();
      setError(null);
      setMessage(null);
      setDownloadProgress(null);

      if (isMac() && !canUseSeamlessUpdater) {
        setUpdateState('checking');
        const response = await window.electronAPI.updater.openTerminalWithCommand();
        userStartedUpdateRef.current = false;
        if (response.success) {
          setUpdateState('idle');
          setMessage('Terminal opened and the update command was copied. Paste it and press Return to open the latest installer.');
        } else {
          setError(response.error || 'Failed to open Terminal');
          setUpdateState('error');
        }
        return;
      }

      setUpdateState('checking');
      const response = await window.electronAPI.updater.checkAndDownload();
      if (!response.success) {
        throw new Error(response.error || 'Failed to check for updates');
      }
    } catch (err: unknown) {
      userStartedUpdateRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to start update');
      setUpdateState('error');
    }
  };

  const handleCopyUpdateCommand = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }

    try {
      const response = await window.electronAPI.updater.copyUpdateCommand();
      if (response.success) {
        setError(null);
        setMessage('Update command copied. Paste it into Terminal and press Return.');
      } else {
        setMessage(null);
        setError(response.error || 'Failed to copy update command');
        setUpdateState('error');
      }
    } catch (err: unknown) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Failed to copy update command');
      setUpdateState('error');
    }
  };

  const handleOpenTerminalWithCommand = async () => {
    if (!window.electronAPI?.updater) {
      setError('Update functionality not available');
      return;
    }

    try {
      const response = await window.electronAPI.updater.openTerminalWithCommand();
      if (response.success) {
        setError(null);
        setMessage('Terminal opened and the update command was copied. Paste it and press Return.');
      } else {
        setMessage(null);
        setError(response.error || 'Failed to open Terminal');
        setUpdateState('error');
      }
    } catch (err: unknown) {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Failed to open Terminal');
      setUpdateState('error');
    }
  };

  const openDmgDownload = () => {
    if (versionInfo?.downloadUrl) {
      window.electronAPI.openExternal(versionInfo.downloadUrl);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSecond: number) => {
    return formatBytes(bytesPerSecond) + '/s';
  };
  const isUpdateBusy = updateState === 'checking' || updateState === 'available' || updateState === 'downloading' || updateState === 'installing';
  const progressMilestone = downloadProgress ? Math.floor(downloadProgress.percent / 10) * 10 : 0;
  const statusAnnouncement = message ?? ({
    idle: '',
    checking: 'Checking for updates',
    available: 'Update available',
    downloading: `Downloading update: ${progressMilestone}%`,
    downloaded: 'Update downloaded',
    installing: 'Installing update',
    error: '',
  } satisfies Record<UpdateState, string>)[updateState];

  const renderMacUpdateActions = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <Button
          onClick={handleOpenTerminalWithCommand}
          variant="primary"
          size="lg"
          fullWidth
          icon={<Terminal className="w-4 h-4" />}
        >
          Copy command and open Terminal
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleCopyUpdateCommand}
            variant="secondary"
            size="sm"
            icon={<Clipboard className="w-4 h-4" />}
          >
            Copy command
          </Button>
          <Button
            onClick={openDmgDownload}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
            disabled={!versionInfo?.downloadUrl}
          >
            Download DMG
          </Button>
          {versionInfo?.releaseUrl && (
            <Button
              onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
              variant="secondary"
              size="sm"
              icon={<ExternalLink className="w-4 h-4" />}
            >
              View on GitHub
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <p className="text-text-secondary">
          This opens Terminal and copies the Pane update command.
          Paste it, press Return, and the latest Pane installer will download and open.
        </p>
        <p className="text-text-secondary">
          After the DMG opens: close Pane, drag Pane.app into Applications, and choose Replace.
          Your settings and sessions are preserved.
        </p>
        <code className="block bg-surface-primary border border-border-primary rounded px-3 py-2 text-xs text-text-primary font-mono break-all">
          curl -fsSL https://runpane.com/install.sh | sh
        </code>
      </div>
    </div>
  );

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      showCloseButton={false}
      closeOnEscape={!isUpdateBusy}
      closeOnOverlayClick={!isUpdateBusy}
    >
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <ModalHeader
        title="Software Update"
        icon={<Download className="w-6 h-6 text-interactive" />}
        onClose={isUpdateBusy ? undefined : onClose}
      />

      <ModalBody className="space-y-6">
          {versionInfo && (
            <div>
              <div className="text-text-secondary mb-2">
                Current version: <span className="font-mono text-text-primary">{versionInfo.current}</span>
              </div>
              {versionInfo.hasUpdate && (
                <div className="text-text-secondary">
                  Latest version: <span className="font-mono text-status-success">{versionInfo.latest}</span>
                </div>
              )}
            </div>
          )}

          {/* Update State UI */}
          <div className="space-y-4">
            {updateState === 'idle' && versionInfo?.hasUpdate && (
              <div className="bg-surface-secondary rounded-lg p-4">
                <h3 className="text-lg font-medium text-text-primary mb-2">Update Available</h3>
                <p className="text-text-secondary mb-4">
                  A new version of Pane is available.
                  {isPackaged && isMac() && !canUseSeamlessUpdater
                    ? ' Click below to open the installer helper.'
                    : isPackaged
                      ? ' Click below to download and install the update.'
                      : ' Auto-update is only available in the packaged app.'}
                </p>

                {isPackaged ? (
                  <Button
                    onClick={handleStartUpdate}
                    variant="primary"
                    icon={<Download className="w-4 h-4" />}
                    disabled={isResolvingUpdateMode}
                  >
                    {isResolvingUpdateMode ? 'Preparing update...' : 'Update Pane'}
                  </Button>
                ) : (
                  <Button
                    onClick={() => versionInfo.releaseUrl && window.electronAPI.openExternal(versionInfo.releaseUrl)}
                    variant="primary"
                  >
                    View Release
                  </Button>
                )}
              </div>
            )}

            {updateState === 'checking' && (
              <div className="flex items-center gap-3 text-text-secondary">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>{isMac() && !canUseSeamlessUpdater ? 'Opening installer helper...' : 'Checking for update...'}</span>
              </div>
            )}

            {updateState === 'available' && (
              <div className="bg-surface-secondary rounded-lg p-4">
                <div className="flex items-center gap-3 text-text-secondary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Preparing update download...</span>
                </div>
                <p className="text-text-tertiary mt-3">
                  Pane will continue automatically.
                </p>
              </div>
            )}

            {updateState === 'downloading' && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 text-text-secondary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Downloading update...</span>
                </div>
                
                {downloadProgress ? (
                  <div className="bg-surface-secondary rounded-lg p-4 space-y-3">
                    <div className="flex justify-between text-sm text-text-tertiary">
                      <span>{formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}</span>
                      <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
                    </div>

                    <div className="w-full bg-surface-tertiary rounded-full h-2">
                      <div
                        className="bg-interactive h-2 rounded-full transition-all duration-300"
                        style={{ width: `${downloadProgress.percent}%` }}
                      />
                    </div>

                    <div className="text-center text-sm text-text-tertiary">
                      {Math.round(downloadProgress.percent)}%
                    </div>
                  </div>
                ) : (
                  <p className="text-text-tertiary">
                    Pane is starting the download.
                  </p>
                )}
              </div>
            )}

            {updateState === 'downloaded' && (
              <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-5 h-5 text-status-success mt-0.5" />
                  <div className="flex-1">
                    <h3 className="text-lg font-medium text-status-success mb-2">Update Downloaded</h3>
                    {isMac() && !canUseSeamlessUpdater ? (
                      <div className="space-y-4">
                        <p className="text-text-secondary">
                          Please install the update manually to ensure it works correctly on macOS.
                        </p>
                        {renderMacUpdateActions()}
                      </div>
                    ) : isMac() ? (
                      <>
                        <p className="text-text-secondary mb-4">
                          The update is ready. Restart Pane to finish installing it.
                        </p>
                        <Button
                          onClick={() => void installDownloadedUpdate()}
                          variant="primary"
                        >
                          Restart now
                        </Button>
                      </>
                    ) : (
                      <>
                        <p className="text-text-secondary mb-4">
                          The update has been downloaded. Pane is starting the installer.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {updateState === 'installing' && (
              <div className="bg-surface-secondary rounded-lg p-4">
                <div className="flex items-center gap-3 text-text-secondary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Starting installer...</span>
                </div>
                <p className="text-text-tertiary mt-3">
                  Pane may close or restart while the update is applied.
                </p>
              </div>
            )}

            {updateState === 'error' && error && (
              <div className="space-y-4">
                {/* Manual Download Box */}
                {isMac() ? (
                  <div className="bg-interactive/10 border border-interactive/30 rounded-lg p-4">
                    <h3 className="text-lg font-medium text-interactive mb-3">Manual Update Available</h3>
                    {renderMacUpdateActions()}
                  </div>
                ) : versionInfo?.releaseUrl && (
                  <div className="bg-interactive/10 border border-interactive/30 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-medium text-interactive mb-1">Manual Update Available</h3>
                        <p className="text-sm text-text-secondary">
                          Automatic update failed, but you can download the latest version manually.
                        </p>
                      </div>
                      <Button
                        onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
                        variant="primary"
                        icon={<Download className="w-4 h-4" />}
                      >
                        Download from GitHub
                      </Button>
                    </div>
                  </div>
                )}

                {/* Error Details */}
              <div role="alert" className="bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-status-error mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-lg font-medium text-status-error mb-2">Update Error</h3>
                      <p className="text-text-secondary mb-2">{error}</p>
                      <div className="space-y-3">
                        {isMac() ? (
                          <p className="text-sm text-text-secondary">
                            Use the update command above, or download the DMG directly. After the DMG opens,
                            close Pane, drag Pane.app into Applications, and choose Replace.
                          </p>
                        ) : (
                          <>
                            <p className="text-sm text-text-tertiary">
                              To update manually:
                            </p>
                            <ol className="text-sm text-text-secondary list-decimal list-inside ml-2 space-y-2">
                              <li>Click "Download from GitHub" above</li>
                              <li>Download the installer from the release page</li>
                              <li>Close Pane</li>
                              <li>Open the downloaded installer</li>
                              <li>Launch the new version of Pane</li>
                            </ol>
                          </>
                        )}
                        <p className="text-sm text-text-tertiary mt-3">
                          Your settings and sessions will be preserved during the update.
                        </p>
                        {(error.includes('404') || error.includes('latest-mac.yml')) && (
                          <div className="mt-3 p-2 bg-surface-primary rounded text-xs text-text-tertiary">
                            <p className="font-semibold mb-1">Technical Details:</p>
                            <p>The release may be missing required update metadata files, or you may be testing with a development version.</p>
                          </div>
                        )}
                      </div>
                      {versionInfo?.releaseUrl && (
                        <button
                          onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
                          className="mt-3 text-sm text-interactive hover:text-interactive-hover underline"
                        >
                          View Release on GitHub
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {message && (
              <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-3 text-sm text-status-success">
                {message}
              </div>
            )}

            {!versionInfo?.hasUpdate && updateState === 'idle' && (
              <div className="text-center py-8">
                <CheckCircle className="w-12 h-12 text-status-success mx-auto mb-3" />
                <p className="text-text-secondary">You're running the latest version of Pane!</p>
              </div>
            )}
          </div>

          {/* Release Notes */}
          {versionInfo?.releaseNotes && (
            <div className="mt-6">
              <h3 className="text-lg font-medium text-text-primary mb-3">Release Notes</h3>
              <div className="bg-surface-secondary rounded-lg p-4 max-h-64 overflow-y-auto">
                <div className="select-text text-sm">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h1 className="text-2xl font-bold mt-4 mb-3 text-text-primary">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-xl font-bold mt-3 mb-2 text-text-primary">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-lg font-bold mt-2 mb-2 text-text-primary">{children}</h3>,
                      h4: ({ children }) => <h4 className="text-base font-bold mt-2 mb-1 text-text-primary">{children}</h4>,
                      p: ({ children }) => <p className="mb-3 text-text-primary">{children}</p>,
                      ul: ({ children }) => <ul className="list-disc mb-3 ml-6 text-text-primary">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal mb-3 ml-6 text-text-primary">{children}</ol>,
                      li: ({ children }) => <li className="mb-1 text-text-primary">{children}</li>,
                      blockquote: ({ children }) => (
                        <blockquote className="border-l-4 border-border-secondary pl-4 italic my-3 text-text-tertiary">
                          {children}
                        </blockquote>
                      ),
                      a: ({ href, children }) => (
                        <a href={href} className="text-interactive hover:text-interactive-hover underline" target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                      code: ({ children }) => (
                        <code className="bg-surface-tertiary px-1 py-0.5 rounded text-text-primary font-mono text-xs">
                          {children}
                        </code>
                      ),
                      hr: () => <hr className="my-4 border-border-primary" />,
                    }}
                  >
                    {versionInfo.releaseNotes}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}
      </ModalBody>

      <ModalFooter>
        <div className="flex justify-between items-center w-full">
          <div className="text-sm text-text-tertiary">
            {versionInfo?.releaseUrl && (
              <button
                onClick={() => window.electronAPI.openExternal(versionInfo.releaseUrl!)}
                className="hover:text-text-secondary underline transition-colors"
              >
                View on GitHub
              </button>
            )}
          </div>
          <Button
            onClick={onClose}
            variant="secondary"
            disabled={isUpdateBusy}
          >
            Close
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
