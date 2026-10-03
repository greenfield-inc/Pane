import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, MessageSquare, SquareTerminal } from 'lucide-react';
import type { Project } from '../types/project';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { nextOrchestrationSessionName } from '../../../shared/types/orchestrationSession';
import { OrchestrationSessionForm } from './CreateOrchestrationSessionDialog';
import { CreatePaneForm } from './CreateSessionDialog';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';

interface NewDialogProps {
  projects: Project[];
  defaultProjectId?: number;
  onClose: () => void;
}

// One modal owns focus for the chooser and both forms. The section + controls
// continue to use the standalone dialogs around these same forms.
export function NewDialog({ projects, defaultProjectId, onClose }: NewDialogProps) {
  const [step, setStep] = useState<'choose' | 'session' | 'pane'>('choose');
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const sessionChoice = useRef<HTMLButtonElement>(null);
  const paneChoice = useRef<HTMLButtonElement>(null);
  const lastChoice = useRef<'session' | 'pane'>('session');
  const project = projects.find(item => item.id === projectId) ?? projects[0];

  useLayoutEffect(() => {
    if (step === 'choose') {
      (lastChoice.current === 'session' ? sessionChoice : paneChoice).current?.focus();
    }
  }, [step]);

  const header = <>
    <ModalHeader title={step === 'session' ? 'Create Session' : 'Create Pane'} />
    <div className="px-6 pt-3">
      <Button type="button" variant="ghost" size="sm" className="focus-visible:ring-interactive" icon={<ArrowLeft className="h-3.5 w-3.5" />} disabled={isSubmitting} onClick={() => setStep('choose')}>Back</Button>
    </div>
  </>;

  return <Modal isOpen onClose={() => { if (!isSubmitting) onClose(); }} size="md" closeOnOverlayClick={false} closeOnEscape={!branchDropdownOpen && !isSubmitting}>
    {step === 'choose' ? <>
      <ModalHeader title="New" />
      <ModalBody className="space-y-3">
        {([
          { id: 'session', title: 'Create Session', description: 'An agent that directs work across Panes.', icon: MessageSquare, ref: sessionChoice },
          { id: 'pane', title: 'Create Pane', description: 'A workspace for one piece of work.', icon: SquareTerminal, ref: paneChoice },
        ] as const).map(choice => <button key={choice.id} ref={choice.ref} type="button" onClick={() => { lastChoice.current = choice.id; setStep(choice.id); }} className="flex w-full items-center gap-3 rounded border border-border-primary p-4 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
          <choice.icon className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="flex-1"><span className="block text-sm font-medium text-text-primary">{choice.title}</span><span className="mt-1 block text-sm text-text-secondary">{choice.description}</span></span>
          <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        </button>)}
      </ModalBody>
      <ModalFooter><Button variant="secondary" className="focus-visible:ring-interactive" onClick={onClose}>Cancel</Button></ModalFooter>
    </> : step === 'session' ? <OrchestrationSessionForm isOpen header={header} onClose={onClose} onSubmittingChange={setIsSubmitting} onCreate={async (agent, requestedName, launchCommand, profile, customResume, wslDistribution) => {
      if (!window.electronAPI?.orchestrationSessions) throw new Error('This host does not support Sessions.');
      const store = useOrchestrationSessionStore.getState();
      await store.load();
      const name = requestedName?.trim() || nextOrchestrationSessionName(useOrchestrationSessionStore.getState().sessions);
      await store.create({ name, agent, launchCommand, profile, customResume, runtime: wslDistribution ? 'wsl' : 'windows', wslDistribution });
      useSessionStore.getState().setActiveSession(null);
      useNavigationStore.getState().navigateToPaneChat();
      onClose();
    }} /> : project ? <CreatePaneForm key={project.id} isOpen projectId={project.id} projectName={project.name} onClose={onClose} header={header} onBranchDropdownOpenChange={setBranchDropdownOpen} onSubmittingChange={setIsSubmitting} repositoryPicker={
      <div className="px-6 pt-4">
        <label htmlFor="new-pane-repository" className="mb-2 block text-sm font-medium text-text-primary">Repository</label>
        <select id="new-pane-repository" value={project.id} disabled={isSubmitting} onChange={event => setProjectId(Number(event.target.value))} className="w-full rounded border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
          {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
    } /> : <>
      {header}
      <ModalBody><p className="text-sm text-text-secondary">A Pane needs a repository. Add one with the + beside Projects.</p></ModalBody>
      <ModalFooter><Button variant="secondary" className="focus-visible:ring-interactive" onClick={onClose}>Close</Button></ModalFooter>
    </>}
  </Modal>;
}
