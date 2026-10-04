import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { HostChip } from './HostChip';
import { HostFolderField } from './HostFolderField';
import { API } from '../utils/api';
import { useNavigationStore } from '../stores/navigationStore';
import { useActiveHost } from '../hooks/useActiveHost';
import { buildCloneOptions, buildCreateProjectRequest, defaultCloneDestination } from '../utils/hostRepoActions';
import { EMPTY_CLONE_DRAFT, LOCAL_CLONE_HOST, useCloneDraftStore, type CloneDraft } from '../stores/cloneDraftStore';
import { openHostTerminal } from '../utils/hostTerminal';
import { getGitHubSignInTerminalCommand, getHostTerminalShell } from '../utils/githubSignIn';
import { buildDeviceLoginStartRequest } from '../utils/githubDeviceLogin';
import { useGitHubDeviceLogin } from '../hooks/useGitHubDeviceLogin';
import { useConfigStore } from '../stores/configStore';
import { openHostGitHubSettings } from '../utils/hostSettings';
import { CloneSignInNotice } from './CloneSignInNotice';
import { GIT_CLONE_AUTH_REQUIRED } from '../../../shared/types/gitClone';


interface CloneFromGitHubDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function CloneFromGitHubDialog({ isOpen, onClose }: CloneFromGitHubDialogProps) {
  const [cloning, setCloning] = useState(false);
  const [terminalError, setTerminalError] = useState('');

  const navigateToProject = useNavigationStore(s => s.navigateToProject);
  const host = useActiveHost();
  const defaultDestination = defaultCloneDestination(host);
  const hostId = host.id ?? LOCAL_CLONE_HOST;
  const storedDraft = useCloneDraftStore();
  const { url, destPath, error, signInHost, signInOverSsh } = storedDraft.hostId === hostId ? storedDraft : EMPTY_CLONE_DRAFT;
  const updateDraft = (draft: Partial<CloneDraft>) => storedDraft.update(hostId, draft);
  const profiles = useConfigStore((state) => state.config?.remoteDaemon?.client.profiles);
  const activeProfile = profiles?.find((profile) => profile.id === host.id) ?? null;
  const managedInSettings = host.remote && activeProfile?.githubSignIn === 'settings';
  const deviceLogin = useGitHubDeviceLogin(isOpen && signInHost !== null && !managedInSettings);

  // A remote clone lands in the host's home unless the user picks a folder.
  useEffect(() => {
    if (isOpen && !destPath && defaultDestination) {
      useCloneDraftStore.getState().update(hostId, { destPath: defaultDestination });
    }
  }, [isOpen, destPath, defaultDestination, hostId]);

  const setError = (value: string) => updateDraft({ error: value, signInHost: null });

  const resetAndClose = () => {
    storedDraft.reset();
    setCloning(false);
    setTerminalError('');
    onClose();
  };

  // Closes without clearing the draft, so the user can come back and try again.
  const handleOpenTerminal = async () => {
    if (!signInHost) return;
    setTerminalError('');
    try {
      const shell = await getHostTerminalShell();
      await openHostTerminal({ input: getGitHubSignInTerminalCommand(shell) });
      onClose();
    } catch (err) {
      setTerminalError(err instanceof Error ? err.message : `Could not open the terminal on ${signInHost}`);
    }
  };

  // Closes without clearing the draft, so the user can add the token and come back to try again.
  const handleOpenSettings = () => {
    onClose();
    openHostGitHubSettings();
  };

  const handleSignIn = () => {
    if (!signInHost) return;
    void deviceLogin.start(buildDeviceLoginStartRequest(signInHost, activeProfile));
  };

  const handleClone = async () => {
    if (!url || !destPath) return;
    setCloning(true);
    setTerminalError('');
    // A sign-in notice stays up while its Try again runs.
    updateDraft({ error: '' });
    try {
      const cloneResult = await API.git.cloneRepo(url, destPath, buildCloneOptions(host));
      if (!cloneResult.success || !cloneResult.data) {
        updateDraft({
          error: cloneResult.error ?? 'Clone failed',
          signInHost: host.remote && cloneResult.code === GIT_CLONE_AUTH_REQUIRED ? host.name : null,
          signInOverSsh: cloneResult.authProtocol === 'ssh',
        });
        setCloning(false);
        return;
      }

      const { clonedPath, repoName } = cloneResult.data;

      const projectResult = await API.projects.create(
        buildCreateProjectRequest(host, { name: repoName, path: clonedPath, mode: 'open' }),
      );

      if (!projectResult.success || !projectResult.data) {
        setError(projectResult.error ?? 'Failed to create project');
        setCloning(false);
        return;
      }

      window.dispatchEvent(new Event('project-changed'));
      navigateToProject(projectResult.data.id);
      resetAndClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setCloning(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={resetAndClose} size="lg">
      <ModalHeader
        title="Clone from GitHub"
        icon={<GitHubIcon className="w-5 h-5" />}
      />
      <ModalBody>
        <div className="space-y-6">
          <HostChip host={host} />
          <FieldWithTooltip
            label="Repository URL"
            tooltip="The HTTPS or SSH URL of the GitHub repository to clone"
          >
            <EnhancedInput
              type="text"
              aria-label="Repository URL"
              value={url}
              onChange={(e) => {
                updateDraft({ url: e.target.value, error: '', signInHost: null });
              }}
              placeholder="https://github.com/user/repo"
              size="lg"
              fullWidth
            />
          </FieldWithTooltip>

          <FieldWithTooltip
            label="Destination"
            tooltip={`The folder on ${host.name} that the repository is cloned into`}
          >
            <HostFolderField
              host={host}
              label="Destination"
              value={destPath}
              onChange={(value) => {
                updateDraft({ destPath: value, error: '', signInHost: null });
              }}
              placeholder="Select a destination folder..."
              allowCreate
            />
          </FieldWithTooltip>

          {signInHost ? (
            <CloneSignInNotice
              host={signInHost}
              overSsh={signInOverSsh}
              managedInSettings={managedInSettings}
              onOpenSettings={handleOpenSettings}
              retrying={cloning}
              deviceLogin={deviceLogin.state}
              deviceLoginError={deviceLogin.requestError}
              onSignIn={handleSignIn}
              onCancelSignIn={() => void deviceLogin.cancel()}
              onOpenTerminal={() => void handleOpenTerminal()}
              onTryAgain={() => void handleClone()}
            />
          ) : error && (
            <div role="alert" className="text-sm text-status-error">{error}</div>
          )}
          {terminalError && (
            <div className="text-sm text-status-error">{terminalError}</div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button onClick={resetAndClose} variant="ghost" size="md">
          Cancel
        </Button>
        <Button
          onClick={handleClone}
          variant="primary"
          size="md"
          loading={cloning}
          loadingText="Cloning..."
          disabled={!url || !destPath}
        >
          Clone
        </Button>
      </ModalFooter>
    </Modal>
  );
}
