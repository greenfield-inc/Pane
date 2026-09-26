import { useState, useEffect, useCallback, useRef } from 'react';
import { API } from '../utils/api';
import { GitFork, AlertCircle, Star, ExternalLink, Loader2 } from 'lucide-react';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { capture } from '../services/posthog';

type DialogStep = 'detecting' | 'ready';
type OnboardingEnvironmentStatus = 'detecting' | 'git_missing' | 'gh_ready' | 'gh_missing' | 'gh_not_authenticated' | 'gh_missing_scopes' | 'gh_not_ready';

interface EnvironmentInfo {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghReady: boolean;
  ghScopes: string[];
  requiredGhScopes: string[];
  missingGhScopes: string[];
  ghAuthCommand?: string;
  ghInstallUrl: string;
}

interface OnboardingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SupportPaneDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const GITHUB_CLI_URL = 'https://cli.github.com/';
export const ONBOARDING_REPO_SETUP_PREFERENCE = 'onboarding_repo_setup';
export const ONBOARDING_GH_PROMPT_SHOWN_PREFERENCE = 'onboarding_gh_prompt_shown';
const ONBOARDING_GH_STATUS_AT_FIRST_LAUNCH_PREFERENCE = 'onboarding_gh_status_at_first_launch';

function fallbackEnvironment(): EnvironmentInfo {
  return {
    gitInstalled: false,
    ghInstalled: false,
    ghAuthenticated: false,
    ghReady: false,
    ghScopes: [],
    requiredGhScopes: ['user'],
    missingGhScopes: ['user'],
    ghInstallUrl: GITHUB_CLI_URL,
  };
}

function normalizeEnvironment(value: Partial<EnvironmentInfo> | null | undefined): EnvironmentInfo {
  const fallback = fallbackEnvironment();
  return {
    ...fallback,
    ...value,
    ghScopes: Array.isArray(value?.ghScopes) ? value.ghScopes : fallback.ghScopes,
    requiredGhScopes: Array.isArray(value?.requiredGhScopes) ? value.requiredGhScopes : fallback.requiredGhScopes,
    missingGhScopes: Array.isArray(value?.missingGhScopes) ? value.missingGhScopes : fallback.missingGhScopes,
    ghInstallUrl: value?.ghInstallUrl || fallback.ghInstallUrl,
  };
}

function getEnvironmentStatus(env: EnvironmentInfo | null): OnboardingEnvironmentStatus {
  if (!env) return 'detecting';
  if (!env.gitInstalled) return 'git_missing';
  if (env.ghReady) return 'gh_ready';
  if (!env.ghInstalled) return 'gh_missing';
  if (!env.ghAuthenticated) return 'gh_not_authenticated';
  if (env.missingGhScopes.length > 0) return 'gh_missing_scopes';
  return 'gh_not_ready';
}

async function getPreference(key: string): Promise<string | null> {
  if (!window.electronAPI?.preferences) return null;
  return API.preferences.get(key);
}

async function setPreference(key: string, value: string): Promise<void> {
  if (window.electronAPI?.preferences) await API.preferences.set(key, value);
}

async function markSupportPromptShown(): Promise<void> {
  await setPreference(ONBOARDING_GH_PROMPT_SHOWN_PREFERENCE, 'true');
}

async function recordFirstLaunchEnvironmentStatus(status: OnboardingEnvironmentStatus): Promise<void> {
  const existing = await getPreference(ONBOARDING_GH_STATUS_AT_FIRST_LAUNCH_PREFERENCE);
  if (existing) return;
  await setPreference(ONBOARDING_GH_STATUS_AT_FIRST_LAUNCH_PREFERENCE, status);
}

function SupportExplainer({ showTitle = true }: { showTitle?: boolean }) {
  return (
    <div className="space-y-1">
      {showTitle && (
        <p className="text-sm font-semibold text-text-primary">Support Pane with a star and follow</p>
      )}
      <p className="text-xs leading-relaxed text-text-secondary">
        Pane is built by Parsa, a self-funded developer. A GitHub star for Pane and a follow are the easiest free way to support the project so it can keep growing.
      </p>
    </div>
  );
}

export function SupportPaneDialog({ isOpen, onClose }: SupportPaneDialogProps) {
  const paneLogo = usePaneLogo();
  const [isSupporting, setIsSupporting] = useState(false);

  const handleSupport = async () => {
    setIsSupporting(true);
    try {
      const supportResult = await window.electronAPI.onboarding.supportProject();
      if (supportResult?.success) {
        capture('onboarding_project_supported_after_setup');
      }
    } catch {
      // Support failure is non-fatal and should not keep nagging.
    } finally {
      setIsSupporting(false);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      ariaLabel="Support Pane"
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      closeOnOverlayClick
      closeOnEscape
      showCloseButton
    >
      <div className="p-6 border-b border-border-primary">
        <div className="flex items-center">
          <img src={paneLogo} alt="Pane" className="h-10 w-10 mr-3" />
          <h1 className="text-lg font-semibold text-text-primary">Support Pane</h1>
        </div>
      </div>
      <ModalBody>
        <div className="flex items-start gap-3">
          <Star className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
          <SupportExplainer />
        </div>
      </ModalBody>
      <ModalFooter className="flex justify-end gap-2">
        <Button onClick={onClose} variant="ghost">
          Not now
        </Button>
        <Button
          onClick={handleSupport}
          variant="primary"
          icon={<Star className="h-4 w-4" />}
          loading={isSupporting}
          loadingText="Supporting"
        >
          Star and follow
        </Button>
      </ModalFooter>
    </Modal>
  );
}

export default function OnboardingDialog({ isOpen, onClose }: OnboardingDialogProps) {
  const paneLogo = usePaneLogo();
  const [step, setStep] = useState<DialogStep>('detecting');
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [shouldSupportOnSetup, setShouldSupportOnSetup] = useState(true);
  const [showSupportPopover, setShowSupportPopover] = useState(false);
  const [showOptOutConfirm, setShowOptOutConfirm] = useState(false);
  const supportPromptRecordedRef = useRef(false);

  const markOnboardingComplete = async () => {
    try {
      await setPreference(ONBOARDING_REPO_SETUP_PREFERENCE, 'true');
    } catch {
      // Ensure dialog closes even if preference write fails
    }
  };

  const detectEnvironment = useCallback(async (options?: { showLoading?: boolean }): Promise<EnvironmentInfo> => {
    if (options?.showLoading !== false) {
      setStep('detecting');
    }

    try {
      const result = await window.electronAPI.onboarding.detectEnvironment();
      if (result.success && result.data) {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        const nextEnv = normalizeEnvironment(result.data as Partial<EnvironmentInfo>);
        setEnv(nextEnv);
        setStep('ready');
        return nextEnv;
      }

      const nextEnv = fallbackEnvironment();
      setEnv(nextEnv);
      setStep('ready');
      return nextEnv;
    } catch {
      const nextEnv = fallbackEnvironment();
      setEnv(nextEnv);
      setStep('ready');
      return nextEnv;
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      supportPromptRecordedRef.current = false;
      void detectEnvironment().then((nextEnv) => {
        const status = getEnvironmentStatus(nextEnv);
        capture('onboarding_started', {
          gh_status_at_first_launch: status,
        });
        void recordFirstLaunchEnvironmentStatus(status);
      });
    }
  }, [isOpen, detectEnvironment]);

  useEffect(() => {
    if (!isOpen || !env?.ghReady || supportPromptRecordedRef.current) return;
    supportPromptRecordedRef.current = true;
    capture('onboarding_support_prompt_shown', {
      source: 'first_launch',
      gh_status: getEnvironmentStatus(env),
    });
    void markSupportPromptShown();
  }, [isOpen, env]);

  const setupDefaultRepoInBackground = () => {
    void window.electronAPI.onboarding.setupDefaultRepo()
      .then((result) => {
        if (result.success) {
          window.dispatchEvent(new Event('project-changed'));
        } else {
          console.error('[Onboarding] Background setup failed:', result.error || 'Failed to set up project');
        }
      })
      .catch((error) => {
        console.error('[Onboarding] Background setup failed:', error);
      });
  };

  const supportProjectInBackground = () => {
    void window.electronAPI.onboarding.supportProject()
      .then((supportResult) => {
        if (supportResult?.success) {
          capture('onboarding_project_supported_during_setup');
        }
      })
      .catch(() => {
        // Support failure is non-fatal.
      });
  };

  const handleSetup = async () => {
    if (!env?.gitInstalled) {
      return;
    }

    await markOnboardingComplete();
    onClose();

    if (shouldSupportOnSetup && env?.ghReady) {
      supportProjectInBackground();
    }

    setupDefaultRepoInBackground();
  };

  const handleSkip = async () => {
    capture('onboarding_skipped', {
      step: step === 'detecting' ? 'detecting' : getEnvironmentStatus(env),
    });
    await markOnboardingComplete();
    onClose();
  };

  const handleSupportCheckboxChange = (checked: boolean) => {
    if (!checked && shouldSupportOnSetup) {
      setShowSupportPopover(false);
      setShowOptOutConfirm(true);
      return;
    }

    setShouldSupportOnSetup(checked);
  };

  const handleKeepSupporting = () => {
    setShouldSupportOnSetup(true);
    setShowOptOutConfirm(false);
  };

  const handleConfirmOptOut = () => {
    setShouldSupportOnSetup(false);
    setShowOptOutConfirm(false);
  };

  const handleOpenGitGuide = () => {
    window.electronAPI.openExternal('https://git-scm.com/downloads');
  };

  if (!isOpen) return null;

  return (
    <Modal
      ariaLabel="Get Started with Pane"
      isOpen={isOpen}
      onClose={() => {}}
      size="md"
      closeOnOverlayClick={false}
      closeOnEscape={false}
      showCloseButton={false}
    >
      {/* Header */}
      <div className="p-6 border-b border-border-primary">
        <div className="flex items-center">
          <img src={paneLogo} alt="Pane" className="h-10 w-10 mr-3" />
          <h1 className="text-lg font-semibold text-text-primary">Get Started with Pane</h1>
        </div>
      </div>

      <ModalBody className={step === 'ready' && env?.ghReady ? 'overflow-visible' : undefined}>
        {step === 'detecting' && (
          <div className="flex flex-col items-center py-8 gap-4">
            <Loader2 className="h-8 w-8 text-interactive animate-spin" />
            <p className="text-text-secondary">Checking your setup...</p>
          </div>
        )}

        {step === 'ready' && env && (
          <div className="space-y-4">
            {env.ghReady ? (
              <>
                <div className="flex items-start gap-3">
                  <GitFork className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <p className="text-text-primary font-medium">
                      Start developing with Pane as your first project
                    </p>
                    <p className="text-text-secondary text-sm">
                      We&apos;ll set up a real codebase so you&apos;re not staring at a blank screen.
                    </p>
                  </div>
                </div>
                <div
                  className="relative w-fit ml-9"
                  onMouseEnter={() => {
                    if (!showOptOutConfirm) setShowSupportPopover(true);
                  }}
                  onMouseLeave={() => setShowSupportPopover(false)}
                  onFocus={() => {
                    if (!showOptOutConfirm) setShowSupportPopover(true);
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) {
                      setShowSupportPopover(false);
                    }
                  }}
                >
                  {(showSupportPopover || showOptOutConfirm) && (
                    <div className="absolute left-0 bottom-full mb-3 w-80 z-30 rounded-lg border border-border-primary bg-surface-primary shadow-lg p-4">
                      {showOptOutConfirm ? (
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <p className="text-sm font-semibold text-text-primary">Keep supporting independent development?</p>
                            <SupportExplainer showTitle={false} />
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={handleConfirmOptOut}>
                              Uncheck anyway
                            </Button>
                            <Button variant="primary" size="sm" onClick={handleKeepSupporting}>
                              Keep supporting
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <SupportExplainer />
                      )}
                    </div>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer w-fit">
                    <input
                      type="checkbox"
                      checked={shouldSupportOnSetup}
                      onChange={(e) => handleSupportCheckboxChange(e.target.checked)}
                      className="rounded border-border-primary text-interactive focus:ring-interactive"
                    />
                    <Star className="h-3.5 w-3.5 text-text-secondary flex-shrink-0" />
                    <span className="text-text-secondary text-xs underline decoration-dotted underline-offset-2">
                      Help us keep building Pane independently
                    </span>
                  </label>
                </div>
              </>
            ) : !env.gitInstalled ? (
              <div className="flex items-start gap-3">
                <AlertCircle className="h-6 w-6 text-status-warning flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-text-primary font-medium">
                    Git Required
                  </p>
                  <p className="text-text-secondary text-sm">
                    Git is required to use Pane. Please install Git and restart the application.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <GitFork className="h-6 w-6 text-interactive flex-shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-text-primary font-medium">
                    Start with a local clone
                  </p>
                  <p className="text-text-secondary text-sm">
                    We&apos;ll clone Pane with Git so you can get into the app now. If GitHub CLI is ready on a future launch, we&apos;ll ask once about starring and following then.
                  </p>
                </div>
              </div>
            )}
            {!env.ghReady && env.gitInstalled && (
              <p className="text-xs text-text-secondary">
                GitHub CLI is optional. Plain Git can clone the repository, but starring, following, and fork creation require GitHub authentication.
              </p>
            )}
          </div>
        )}

      </ModalBody>

      <ModalFooter className="flex justify-between items-center">
        {step === 'detecting' && (
          <>
            <Button onClick={handleSkip} variant="ghost">Skip</Button>
            <div />
          </>
        )}

        {step === 'ready' && env && (
          <>
            <Button onClick={handleSkip} variant="ghost">Skip</Button>
            {env.ghReady ? (
              <Button onClick={handleSetup} variant="primary" icon={<GitFork className="h-4 w-4" />}>
                Let&apos;s go
              </Button>
            ) : !env.gitInstalled ? (
              <Button onClick={handleOpenGitGuide} variant="primary" icon={<ExternalLink className="h-4 w-4" />}>
                Install Git
              </Button>
            ) : (
              <Button
                onClick={handleSetup}
                variant="primary"
                icon={<GitFork className="h-4 w-4" />}
              >
                Start with local clone
              </Button>
            )}
          </>
        )}

      </ModalFooter>
    </Modal>
  );
}
