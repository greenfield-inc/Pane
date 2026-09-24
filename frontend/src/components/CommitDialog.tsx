import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GitCommit } from 'lucide-react';
import { composeCommitMessage, isCommitSubmitShortcut } from '../../../shared/utils/commitMessage';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../stores/configStore';

interface CommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCommit: (message: string) => Promise<void>;
  fileCount: number;
}

export const CommitDialog: React.FC<CommitDialogProps> = ({
  isOpen,
  onClose,
  onCommit,
  fileCount
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));

  // Set default message
  useEffect(() => {
    if (isOpen) {
      setTitle(`Update ${fileCount} file${fileCount > 1 ? 's' : ''}`);
      setDescription('');
      setError(null);
      // Focus and select all text after a short delay
      const focusTimer = window.setTimeout(() => {
        if (titleRef.current) {
          titleRef.current.focus();
          titleRef.current.select();
        }
      }, 100);

      return () => window.clearTimeout(focusTimer);
    }
  }, [isOpen, fileCount]);

  const handleCommit = useCallback(async () => {
    if (!title.trim()) {
      setError('Please enter a title');
      return;
    }

    setIsCommitting(true);
    setError(null);

    try {
      await onCommit(composeCommitMessage(title, description));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit changes');
    } finally {
      setIsCommitting(false);
    }
  }, [description, onCommit, onClose, title]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isCommitSubmitShortcut(e, keyboardShortcutsEnabled, !isCommitting && !!title.trim())) {
      e.preventDefault();
      void handleCommit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [handleCommit, isCommitting, keyboardShortcutsEnabled, onClose, title]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalHeader 
        icon={<GitCommit className="w-5 h-5" />}
        title="Commit Changes"
        onClose={onClose}
      />
      
      <ModalBody>
        <p className="text-sm text-text-secondary mb-4">
          Committing {fileCount} file{fileCount > 1 ? 's' : ''} with changes
        </p>
        
        <div className="space-y-4">
          <Input
            ref={titleRef}
            label="Title"
            value={title}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setTitle(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Enter commit title..."
            error={error ?? undefined}
            fullWidth
          />
          <Textarea
            label="Description (optional)"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add more details..."
            rows={4}
            fullWidth
          />
        </div>
        
        <p className="mt-2 text-xs text-text-tertiary">
          Press {formatKeyDisplay('mod+enter')} to commit
        </p>
      </ModalBody>

      <ModalFooter>
        <Button
          onClick={onClose}
          disabled={isCommitting}
          variant="secondary"
        >
          Cancel
        </Button>
        <Button
          onClick={handleCommit}
          disabled={isCommitting || !title.trim()}
          variant="primary"
          loading={isCommitting}
          loadingText="Committing..."
        >
          <GitCommit className="w-4 h-4" />
          Commit
        </Button>
      </ModalFooter>
    </Modal>
  );
};
