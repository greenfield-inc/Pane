import { useEffect, useMemo, useState } from 'react';
import { FolderPlus, GitBranch } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { Card } from './ui/Card';
import { API } from '../utils/api';
import { useNavigationStore } from '../stores/navigationStore';
import type { CreateProjectRequest, Project } from '../types/project';
import { useConfigStore } from '../stores/configStore';
import { AGENT_LAUNCH_PRESETS } from '../../../shared/constants/agentLaunchPresets';
import { getCliBrandIcon } from './ui/brandIconRegistry';
import { useWorkspaceEntryStore } from '../stores/workspaceEntryStore';

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddProjectDialog({ isOpen, onClose }: AddProjectDialogProps) {
  const [newProject, setNewProject] = useState<CreateProjectRequest>({ name: '', path: '', buildScript: '', runScript: '' });
  const [detectedBranch, setDetectedBranch] = useState<string | null>(null);
  const [branchDetectionFailed, setBranchDetectionFailed] = useState(false);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const config = useConfigStore(state => state.config);
  const fetchConfig = useConfigStore(state => state.fetchConfig);
  const launchPreset = useMemo(
    () => AGENT_LAUNCH_PRESETS.find(preset => preset.id === config?.defaultOrchestratorAgent) ?? null,
    [config?.defaultOrchestratorAgent],
  );

  const navigateToProject = useNavigationStore(s => s.navigateToProject);

  useEffect(() => {
    if (isOpen && !config) void fetchConfig().catch(() => undefined);
  }, [config, fetchConfig, isOpen]);

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
    setIsCreating(true);
    setCreateError(undefined);
    try {
      const projectToCreate: CreateProjectRequest = launchPreset
        ? { ...newProject, launchDefaultAgent: true, disclosedAgent: launchPreset.id }
        : { ...newProject };

      const response = await API.projects.create(projectToCreate);
      if (!response.success || !response.data) {
        setCreateError(response.error || 'Failed to create repository');
        return;
      }

      const createdProject: Project = response.data;
      const newProjectId = createdProject.id;
      if (createdProject.defaultAgentLaunch?.status === 'failed') {
        const failure = createdProject.defaultAgentLaunch;
        useWorkspaceEntryStore.getState().setLaunchFailure({
          projectId: newProjectId,
          agentType: failure.agentType,
          agentTitle: failure.agentTitle,
          initialCommand: failure.initialCommand,
          message: failure.message,
        });
      }

      // Reset form state and close
      resetAndClose();

      // Dispatch event for ProjectSessionList to refresh
      window.dispatchEvent(new Event('project-changed'));

      // Navigate to the new project
      navigateToProject(newProjectId);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create repository');
    } finally {
      setIsCreating(false);
    }
  };

  const resetAndClose = () => {
    setNewProject({ name: '', path: '', buildScript: '', runScript: '' });
    setDetectedBranch(null);
    setBranchDetectionFailed(false);
    setShowValidationErrors(false);
    setCreateError(undefined);
    setIsCreating(false);
    onClose();
  };

  const handleClose = () => {
    if (!isCreating) resetAndClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="lg"
    >
      <ModalHeader title="Add New Repository" icon={<FolderPlus className="w-5 h-5" />} />
      <ModalBody>
        <div className="space-y-6">
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
            tooltip="Path to a git repository. ~ and relative paths are expanded to an absolute path."
          >
            <div className="space-y-2">
              <EnhancedInput
                type="text"
                value={newProject.path}
                onChange={(e) => {
                  setNewProject({ ...newProject, path: e.target.value });
                  detectCurrentBranch(e.target.value);
                  if (showValidationErrors) setShowValidationErrors(false);
                }}
                placeholder="/path/to/your/repository"
                size="lg"
                fullWidth
                required
                showRequiredIndicator={showValidationErrors}
              />
              <div className="flex justify-end">
                <Button
                  onClick={async () => {
                    // SAFETY: The named IPC/API channel contract establishes this response payload type.
                    const result = await window.electron?.invoke('dialog:open-directory') as { success: boolean; data?: string } | undefined;
                    if (result?.success && result.data) {
                      setNewProject({ ...newProject, path: result.data });
                      detectCurrentBranch(result.data);
                    }
                  }}
                  variant="secondary"
                  size="sm"
                >
                  Browse
                </Button>
              </div>
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

          {launchPreset && (
            <Card variant="bordered" padding="md">
              <div className="flex items-start gap-3 text-sm text-text-secondary">
                <span className="mt-0.5 text-text-primary">{getCliBrandIcon(launchPreset.iconKey)}</span>
                <p>
                  Creating this repository will start <strong className="text-text-primary">{launchPreset.title}</strong> in it
                  {' '}(<code className="font-mono text-text-primary">{launchPreset.command}</code>). Close the tab at any time.
                </p>
              </div>
            </Card>
          )}

          {createError && <p role="alert" className="text-sm text-status-error">{createError}</p>}

        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          onClick={resetAndClose}
          variant="ghost"
          size="md"
          disabled={isCreating}
        >
          Cancel
        </Button>
        <Button
          onClick={handleCreateProject}
          disabled={!newProject.name || !newProject.path || isCreating}
          variant="primary"
          size="md"
        >
          {isCreating ? (launchPreset ? `Starting ${launchPreset.title}…` : 'Creating…') : 'Create'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
