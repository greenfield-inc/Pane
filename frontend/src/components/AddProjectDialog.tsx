import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus, GitBranch } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { Card } from './ui/Card';
import { HostChip } from './HostChip';
import { HostFolderField } from './HostFolderField';
import { API } from '../utils/api';
import { useNavigationStore } from '../stores/navigationStore';
import { useActiveHost } from '../hooks/useActiveHost';
import { buildCreateProjectRequest, withHostLabel } from '../utils/hostRepoActions';
import type { CreateProjectRequest } from '../types/project';
import type { ProjectPathMode } from '../../../shared/types/hostPaths';

const PATH_CHECK_DELAY_MS = 300;

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 'open' adds an existing repo on the active host; 'new' creates one there. */
  mode: ProjectPathMode;
}

export function AddProjectDialog({ isOpen, onClose, mode }: AddProjectDialogProps) {
  const [newProject, setNewProject] = useState<CreateProjectRequest>({ name: '', path: '', buildScript: '', runScript: '' });
  const [detectedBranch, setDetectedBranch] = useState<string | null>(null);
  const [branchDetectionFailed, setBranchDetectionFailed] = useState(false);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const navigateToProject = useNavigationStore(s => s.navigateToProject);
  const host = useActiveHost();
  const path = newProject.path;

  // Typed paths are checked on the host itself, so a path from this computer
  // is caught before Create. Failures without a code (an older host without
  // this check) stay quiet; Create still reports them.
  useEffect(() => {
    setPathError(null);
    if (!isOpen || !path.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void API.projects.validatePath(withHostLabel(host, { path, mode }))
        .then((response) => {
          if (!cancelled && !response.success && response.code) setPathError(response.error ?? null);
        })
        .catch(() => undefined);
    }, PATH_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, path, mode, host]);

  const detectCurrentBranch = async (path: string) => {
    if (!path) {
      setDetectedBranch(null);
      setBranchDetectionFailed(false);
      return;
    }
    setDetectedBranch(null);
    setBranchDetectionFailed(false);
    try {
      const response = await API.projects.detectBranch(path);
      if (response.success && response.data) {
        setDetectedBranch(response.data);
        setBranchDetectionFailed(false);
      } else {
        setDetectedBranch(null);
        setBranchDetectionFailed(true);
      }
    } catch {
      setDetectedBranch(null);
      setBranchDetectionFailed(true);
    }
  };

  const handleCreateProject = async () => {
    if (!newProject.name || !newProject.path) {
      setShowValidationErrors(true);
      return;
    }
    setSubmitError(null);
    try {
      const response = await API.projects.create(buildCreateProjectRequest(host, { ...newProject, mode }));
      if (!response.success || !response.data) {
        setSubmitError(response.error ?? 'Failed to add the project.');
        return;
      }

      const newProjectId = response.data.id;

      // Reset form state and close
      resetAndClose();

      // Dispatch event for ProjectSessionList to refresh
      window.dispatchEvent(new Event('project-changed'));

      // Navigate to the new project
      navigateToProject(newProjectId);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to add the project.');
    }
  };

  const resetAndClose = () => {
    setNewProject({ name: '', path: '', buildScript: '', runScript: '' });
    setDetectedBranch(null);
    setBranchDetectionFailed(false);
    setShowValidationErrors(false);
    setPathError(null);
    setSubmitError(null);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={resetAndClose}
      size="lg"
    >
      <ModalHeader
        title={mode === 'new' ? 'New Project' : 'Open Repository'}
        icon={mode === 'new' ? <FolderPlus className="w-5 h-5" /> : <FolderOpen className="w-5 h-5" />}
      />
      <ModalBody>
        <div className="space-y-6">
          <HostChip host={host} />
          <FieldWithTooltip
            label="Project Name"
            tooltip="A display name for this project in the sidebar"
          >
            <EnhancedInput
              type="text"
              value={newProject.name}
              onChange={(e) => {
                setNewProject({ ...newProject, name: e.target.value });
                if (showValidationErrors) setShowValidationErrors(false);
              }}
              placeholder="Enter project name"
              size="lg"
              fullWidth
              required
              showRequiredIndicator={showValidationErrors}
            />
          </FieldWithTooltip>

          <FieldWithTooltip
            label="Repository Path"
            tooltip={mode === 'new'
              ? `Folder for the new repository on ${host.name}. It is created if it doesn't exist. ~ and relative paths are expanded on ${host.name}.`
              : `Path to an existing git repository on ${host.name}. ~ and relative paths are expanded on ${host.name}.`}
          >
            <div className="space-y-2">
              <HostFolderField
                host={host}
                label="Repository Path"
                value={newProject.path}
                onChange={(value) => {
                  setNewProject({ ...newProject, path: value });
                  detectCurrentBranch(value);
                  setSubmitError(null);
                  if (showValidationErrors) setShowValidationErrors(false);
                }}
                placeholder={host.remote ? '~/path/to/repository' : '/path/to/your/repository'}
                allowCreate={mode === 'new'}
                required
                showRequiredIndicator={showValidationErrors}
              />
              {pathError && (
                <div role="alert" className="text-sm text-status-error">{pathError}</div>
              )}
            </div>
          </FieldWithTooltip>

          {newProject.path && (
            <FieldWithTooltip
              label="Detected Branch"
              tooltip="The main branch Pane will use as the base for worktrees"
            >
              <Card variant="bordered" padding="md">
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <GitBranch className="w-4 h-4" />
                  <span className={`font-mono ${branchDetectionFailed ? 'text-status-error' : ''}`}>
                    {detectedBranch ?? (branchDetectionFailed ? 'Could not detect a git branch' : 'Detecting...')}
                  </span>
                </div>
              </Card>
            </FieldWithTooltip>
          )}

          {submitError && submitError !== pathError && (
            <div role="alert" className="text-sm text-status-error">{submitError}</div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          onClick={resetAndClose}
          variant="ghost"
          size="md"
        >
          Cancel
        </Button>
        <Button
          onClick={handleCreateProject}
          disabled={!newProject.name || !newProject.path}
          variant="primary"
          size="md"
        >
          {mode === 'new' ? 'Create' : 'Open'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
