import { useState } from 'react';
import { RotateCcw, Terminal, Bot } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import type { ResumableSession } from '../../../shared/types/panels';

interface ResumeSessionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: ResumableSession[];
}

export function ResumeSessionsDialog({ isOpen, onClose, sessions }: ResumeSessionsDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(sessions.map(s => s.sessionId))
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggleSession = (sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const handleResumeAll = async () => {
    setIsSubmitting(true);
    try {
      const allIds = sessions.map(s => s.sessionId);
      await window.electronAPI.sessions.resumeInterrupted(allIds);
      onClose();
    } catch (error) {
      console.error('[ResumeSessionsDialog] Failed to resume all sessions:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResumeSelected = async () => {
    setIsSubmitting(true);
    try {
      const selected = Array.from(selectedIds);
      const dismissed = sessions
        .filter(s => !selectedIds.has(s.sessionId))
        .map(s => s.sessionId);

      if (selected.length > 0) {
        await window.electronAPI.sessions.resumeInterrupted(selected);
      }
      if (dismissed.length > 0) {
        await window.electronAPI.sessions.dismissInterrupted(dismissed);
      }
      onClose();
    } catch (error) {
      console.error('[ResumeSessionsDialog] Failed to resume selected sessions:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = async () => {
    setIsSubmitting(true);
    try {
      const allIds = sessions.map(s => s.sessionId);
      await window.electronAPI.sessions.dismissInterrupted(allIds);
      onClose();
    } catch (error) {
      console.error('[ResumeSessionsDialog] Failed to dismiss sessions:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || sessions.length === 0) return null;

  const totalPanels = sessions.reduce((sum, s) => sum + s.panels.length, 0);

  return (
    <Modal isOpen={isOpen} onClose={() => {}} size="md" closeOnOverlayClick={false} closeOnEscape={false} showCloseButton={false}>
      <ModalHeader title="Resume Previous Panes" icon={<RotateCcw className="w-5 h-5" />} />
      <ModalBody>
        <p className="text-text-secondary text-sm mb-4">
          {sessions.length} pane{sessions.length !== 1 ? 's' : ''} with {totalPanels} panel{totalPanels !== 1 ? 's' : ''} were interrupted when the app was last closed. Would you like to resume them?
        </p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {sessions.map(session => (
            <label
              key={session.sessionId}
              className="flex items-center gap-3 p-3 rounded-lg bg-surface-secondary hover:bg-surface-hover cursor-default transition-colors"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(session.sessionId)}
                onChange={() => toggleSession(session.sessionId)}
                className="rounded border-border-primary text-interactive focus:ring-interactive"
              />
              <div className="flex-1 min-w-0">
                <div className="text-text-primary text-sm font-medium truncate">
                  {session.sessionName}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {session.panels.map(panel => (
                    <span
                      key={panel.panelId}
                      className="inline-flex items-center gap-1 text-xs text-text-tertiary"
                      title={`${panel.panelType === 'terminal' ? 'Terminal' : 'Claude'} panel`}
                    >
                      {panel.panelType === 'terminal' ? (
                        <Terminal className="w-3 h-3" />
                      ) : (
                        <Bot className="w-3 h-3" />
                      )}
                      {panel.panelType === 'terminal' ? 'Terminal' : 'Claude'}
                    </span>
                  ))}
                </div>
              </div>
            </label>
          ))}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={handleSkip} disabled={isSubmitting}>
          Skip
        </Button>
        {selectedIds.size > 0 && selectedIds.size < sessions.length && (
          <Button
            variant="secondary"
            onClick={handleResumeSelected}
            loading={isSubmitting}
          >
            Resume Selected ({selectedIds.size})
          </Button>
        )}
        <Button variant="primary" onClick={handleResumeAll} loading={isSubmitting}>
          Resume All
        </Button>
      </ModalFooter>
    </Modal>
  );
}
