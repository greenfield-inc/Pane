import { useEffect, useState } from 'react';
import { Download, Check, Loader2, Github } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal } from './ui/Modal';
import { LiveRegion } from './ui/LiveRegion';

interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  workingDirectory?: string;
  appDirectory?: string;
  buildDate?: string;
  gitCommit?: string;
  buildTimestamp?: number;
  worktreeName?: string;
}

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (versionInfo: VersionInfo) => void;
}

export function AboutDialog({ isOpen, onClose, onUpdate }: AboutDialogProps) {
  const paneLogo = usePaneLogo();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isHandingOff, setIsHandingOff] = useState(false);
  const [hasCheckedForUpdates, setHasCheckedForUpdates] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsHandingOff(false);
      setHasCheckedForUpdates(false);
      loadCurrentVersion();
    }
  }, [isOpen]);

  const loadCurrentVersion = async () => {
    try {
      const result = await window.electronAPI.getVersionInfo();
      if (result.success) {
        setVersionInfo({
          current: result.data.current,
          latest: result.data.current,
          hasUpdate: false,
          workingDirectory: result.data.workingDirectory,
          appDirectory: result.data.appDirectory,
          buildDate: result.data.buildDate,
          gitCommit: result.data.gitCommit,
          buildTimestamp: result.data.buildTimestamp,
          worktreeName: result.data.worktreeName
        });
      }
    } catch (error) {
      console.error('Failed to get version info:', error);
    }
  };

  const checkForUpdates = async () => {
    setIsChecking(true);
    setError(null);

    try {
      const result = await window.electronAPI.checkForUpdates();
      if (result.success && result.data) {
        setVersionInfo(result.data);
        if (result.data.hasUpdate) {
          handleUpdate(result.data);
        }
      } else {
        setError(result.error || 'Failed to check for updates');
      }
    } catch (error) {
      setError('Failed to check for updates');
      console.error('Update check failed:', error);
    } finally {
      setIsChecking(false);
      setHasCheckedForUpdates(true);
    }
  };

  const handleUpdate = (nextVersionInfo: VersionInfo) => {
    setIsHandingOff(true);
    onUpdate(nextVersionInfo);
  };

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch {
      return dateString;
    }
  };

  return (
    <Modal
      ariaLabel="About Pane"
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      restoreFocusOnClose={!isHandingOff}
      className="mx-auto !w-[360px] max-w-full !rounded-xl border border-border-primary !bg-surface-primary !shadow-2xl"
    >
        <LiveRegion>
          {isChecking
            ? 'Checking for updates'
            : hasCheckedForUpdates && !error
              ? versionInfo?.hasUpdate
                ? `Pane ${versionInfo.latest} is available`
                : 'Pane is up to date'
              : ''}
        </LiveRegion>
        <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Main content */}
        <div className="px-8 pt-10 pb-8">
          {/* Logo and branding */}
          <div className="flex flex-col items-center mb-8">
            <img
              src={paneLogo}
              alt="Pane"
              className="w-16 h-16 mb-4"
              onError={(e) => {
                // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <h1 className="text-xl font-semibold text-text-primary tracking-tight">
              Pane
            </h1>
            <p className="text-sm text-text-tertiary mt-1">
              Run AI agents in parallel. Ship faster.
            </p>
          </div>

          {/* Version */}
          <div className="flex items-center justify-center gap-3 mb-6">
            <span className="text-sm text-text-secondary font-mono">
              v{versionInfo?.current || '...'}
            </span>
            {!versionInfo?.hasUpdate && versionInfo?.current && !isChecking && (
              <span className="flex items-center gap-1 text-xs text-status-success">
                <Check aria-hidden="true" className="w-3 h-3 text-status-success" />
                Latest
              </span>
            )}
          </div>

          {/* Update available banner */}
          {versionInfo?.hasUpdate && (
            <div className="mb-6 p-3 rounded-lg bg-interactive/10 border border-interactive/20">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-interactive">
                    v{versionInfo.latest} available
                  </p>
                  {versionInfo.publishedAt && (
                    <p className="text-xs text-interactive/70 mt-0.5">
                      {formatDate(versionInfo.publishedAt)}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => versionInfo && handleUpdate(versionInfo)}
                  className="px-3 py-1.5 bg-interactive hover:bg-interactive-hover text-on-interactive text-xs font-medium rounded-md transition-colors"
                >
                  Update
                </button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-2 mb-6">
            <button
              type="button"
              onClick={checkForUpdates}
              disabled={isChecking}
              aria-busy={isChecking}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-surface-secondary hover:bg-surface-tertiary border border-border-primary text-text-primary text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isChecking ? (
                <>
                  <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
                  <span>Checking...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Check for updates</span>
                </>
              )}
            </button>

            <a
              href="https://discord.gg/BdMyubeAZn"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-discord hover:bg-discord-hover text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              <span>Join Discord</span>
            </a>
          </div>

          {error && (
            <div role="alert" className="mb-6 p-2 bg-status-error/10 border border-status-error/20 rounded text-xs text-status-error text-center">
              {error}
            </div>
          )}

          {/* Links - minimal style */}
          <div className="flex items-center justify-center gap-4 text-xs text-text-tertiary">
            <a
              href="https://github.com/greenfield-inc/Pane"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-text-secondary transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              <span>GitHub</span>
            </a>
            <span aria-hidden="true" className="text-border-primary">•</span>
            <a
              href="https://runpane.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-secondary transition-colors"
            >
              Website
            </a>
            <span aria-hidden="true" className="text-border-primary">•</span>
            <a
              href="https://runpane.com/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-secondary transition-colors"
            >
              Docs
            </a>
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-4 bg-surface-secondary/50 border-t border-border-primary">
          <p className="text-[10px] text-text-tertiary text-center leading-relaxed">
            Made by <a href="https://dcouple.ai" target="_blank" rel="noopener noreferrer" className="hover:text-text-secondary">Dcouple</a> · macOS, Windows & Linux
          </p>
        </div>
        </div>
    </Modal>
  );
}
