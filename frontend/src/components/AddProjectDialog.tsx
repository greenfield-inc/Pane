import { useRef, useState } from 'react';
import { FolderPlus, GitBranch } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { Card } from './ui/Card';
import { API } from '../utils/api';
import { useNavigationStore } from '../stores/navigationStore';
import type { CreateProjectRequest } from '../types/project';

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddProjectDialog({ isOpen, onClose }: AddProjectDialogProps) {
  const [newProject, setNewProject] = useState<CreateProjectRequest>({ name: '', path: '', buildScript: '', runScript: '' });
  const branchRequestGeneration = useRef(0);
  const createRequestGeneration = useRef(0);
  const [detectedBranch, setDetectedBranch] = useState<string | null>(null);
  const [branchDetectionFailed, setBranchDetectionFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidationErrors, setShowValidationErrors] = useState(false);

  const navigateToProject = useNavigationStore(s => s.navigateToProject);

  const detectCurrentBranch = async (path: string) => {
    const generation = ++branchRequestGeneration.current;
    if (!path) {
      setDetectedBranch(null);
      setBranchDetectionFailed(false);
      return;
    }
    setDetectedBranch(null);
    setBranchDetectionFailed(false);
    try {
      const response = await API.projects.detectBranch(path);
      if (generation !== branchRequestGeneration.current) return;
      if (response.success && response.data) {
        setDetectedBranch(response.data);
        setBranchDetectionFailed(false);
      } else {
        setDetectedBranch(null);
        setBranchDetectionFailed(true);
      }
    } catch {
      if (generation !== branchRequestGeneration.current) return;
      setDetectedBranch(null);
      setBranchDetectionFailed(true);
    }
  };

  const handleCreateProject = async () => {
    const generation = ++createRequestGeneration.current;
    setError(null);
    if (!newProject.name || !newProject.path) {
      setShowValidationErrors(true);
      return;
    }
    try {
      const projectToCreate = {
        ...newProject,
        active: false,
      };

      const response = await API.projects.create(projectToCreate);
      if (generation !== createRequestGeneration.current) {
        // A completed creation still belongs in the sidebar, but must not
        // close or navigate away from a newer dialog.
        if (response.success && response.data) window.dispatchEvent(new Event('project-changed'));
        return;
      }
      if (!response.success || !response.data) {
        setError(response.error || 'Failed to create project');
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
      if (generation !== createRequestGeneration.current) return;
      setError(e instanceof Error ? e.message : 'Failed to create project');
    }
  };

  const resetAndClose = () => {
    branchRequestGeneration.current += 1;
    createRequestGeneration.current += 1;
    setNewProject({ name: '', path: '', buildScript: '', runScript: '' });
    setDetectedBranch(null);
    setBranchDetectionFailed(false);
    setShowValidationErrors(false);
    setError(null);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={resetAndClose}
      size="lg"
    >
      <ModalHeader title="Add New Repository" icon={<FolderPlus className="w-5 h-5" />} />
      <ModalBody>
        <div className="space-y-6">
          {error && <div role="alert" className="text-sm text-status-error">{error}</div>}
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
          Create
        </Button>
      </ModalFooter>
    </Modal>
  );
}
