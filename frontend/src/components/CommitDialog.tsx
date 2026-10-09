import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GitCommit, UserRound } from 'lucide-react';
import { composeCommitMessage, isCommitSubmitShortcut } from '../../../shared/utils/commitMessage';
import { GIT_IDENTITY_MISSING, type GitIdentity, type GitIdentityScope } from '../../../shared/types/gitIdentity';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../stores/configStore';

export interface CommitResult {
  success: boolean;
  error?: string;
  details?: string;
  code?: string;
}

interface CommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCommit: (message: string) => Promise<CommitResult>;
  fileCount: number;
  sessionId: string;
}

interface CommitFailure {
  message: string;
  details?: string;
}

export const CommitDialog: React.FC<CommitDialogProps> = ({
  isOpen,
  onClose,
  onCommit,
  fileCount,
  sessionId
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const [showFailureDetails, setShowFailureDetails] = useState(false);
  const [needsIdentity, setNeedsIdentity] = useState(false);
  const [identityName, setIdentityName] = useState('');
  const [identityEmail, setIdentityEmail] = useState('');
  const [identityGlobal, setIdentityGlobal] = useState(true);
  const [isSavingIdentity, setIsSavingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  // Only the latest identity read may apply; saving or closing invalidates older ones.
  const identityRequest = useRef(0);
  const invalidateIdentityReads = useCallback(() => { identityRequest.current++; }, []);
  const titleRef = useRef<HTMLInputElement>(null);
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));

  // Set default message
  useEffect(() => {
    if (isOpen) {
      setTitle(`Update ${fileCount} file${fileCount > 1 ? 's' : ''}`);
      setDescription('');
      setError(null);
      setFailure(null);
      setShowFailureDetails(false);
      setNeedsIdentity(false);
      setIdentityError(null);
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

  const loadIdentity = useCallback(async () => {
    const request = ++identityRequest.current;
    try {
      const response = await window.electronAPI.invoke('git:identity', { sessionId });
      const identity: GitIdentity | null = response.success ? response.data : null;
      if (request !== identityRequest.current || !identity) return;
      setIdentityName(identity.name);
      setIdentityEmail(identity.email);
      if (!identity.configured) setNeedsIdentity(true);
    } catch {
      // The commit itself still reports a missing identity.
    }
  }, [sessionId]);

  // Check up front that git can commit as someone where the repo lives (native or WSL)
  useEffect(() => {
    if (!isOpen) return;
    void loadIdentity();
    return invalidateIdentityReads;
  }, [invalidateIdentityReads, isOpen, loadIdentity]);

  const handleSaveIdentity = useCallback(async () => {
    invalidateIdentityReads();
    setIsSavingIdentity(true);
    setIdentityError(null);
    try {
      const scope: GitIdentityScope = identityGlobal ? 'global' : 'local';
      const response = await window.electronAPI.invoke('git:set-identity', {
        sessionId, name: identityName, email: identityEmail, scope,
      });
      if (!response.success) {
        setIdentityError(response.error || 'Failed to save your git identity');
        return;
      }
      setNeedsIdentity(false);
      setFailure(null);
      titleRef.current?.focus();
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : 'Failed to save your git identity');
    } finally {
      setIsSavingIdentity(false);
    }
  }, [identityEmail, identityGlobal, identityName, invalidateIdentityReads, sessionId]);

  const handleCommit = useCallback(async () => {
    if (!title.trim()) {
      setError('Please enter a title');
      return;
    }

    setIsCommitting(true);
    setError(null);
    setFailure(null);
    setShowFailureDetails(false);

    try {
      const result = await onCommit(composeCommitMessage(title, description));
      if (result.success) {
        onClose();
      } else if (result.code === GIT_IDENTITY_MISSING) {
        setNeedsIdentity(true);
        void loadIdentity();
      } else {
        setFailure({ message: result.error || 'Failed to commit changes', details: result.details });
      }
    } catch (err) {
      setFailure({ message: err instanceof Error ? err.message : 'Failed to commit changes' });
    } finally {
      setIsCommitting(false);
    }
  }, [description, loadIdentity, onCommit, onClose, title]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isCommitSubmitShortcut(e, keyboardShortcutsEnabled, !isCommitting && !needsIdentity && !!title.trim())) {
      e.preventDefault();
      void handleCommit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [handleCommit, isCommitting, keyboardShortcutsEnabled, needsIdentity, onClose, title]);

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

        {needsIdentity && (
          <section
            className="mb-4 space-y-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3"
            aria-label="Set your git identity"
          >
            <div className="flex gap-2">
              <UserRound className="mt-0.5 h-4 w-4 flex-shrink-0 text-status-warning" />
              <div>
                <p className="text-sm font-medium text-text-primary">Git needs your name and email</p>
                <p className="text-xs text-text-secondary">
                  Git has no identity set where this repository lives, so it can&apos;t record who made the commit.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Name"
                value={identityName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIdentityName(e.target.value)}
                placeholder="Your Name"
                fullWidth
              />
              <Input
                label="Email"
                type="email"
                value={identityEmail}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIdentityEmail(e.target.value)}
                placeholder="you@example.com"
                fullWidth
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={identityGlobal}
                onChange={(e) => setIdentityGlobal(e.target.checked)}
              />
              Use for all repositories here (git config --global)
            </label>
            {identityError && <p className="text-xs text-status-error">{identityError}</p>}
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSaveIdentity}
                disabled={isSavingIdentity || !identityName.trim() || !identityEmail.trim()}
                loading={isSavingIdentity}
                loadingText="Saving..."
              >
                Save identity
              </Button>
            </div>
          </section>
        )}

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

        {failure && (
          <div className="mt-3 text-sm text-status-error" role="alert">
            <p>{failure.message}</p>
            {failure.details && failure.details !== failure.message && (
              <>
                <button
                  type="button"
                  className="mt-1 text-xs text-text-secondary underline hover:text-text-primary"
                  onClick={() => setShowFailureDetails(show => !show)}
                  aria-expanded={showFailureDetails}
                >
                  {showFailureDetails ? 'Hide details' : 'Show details'}
                </button>
                {showFailureDetails && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-xs text-text-secondary">
                    {failure.details}
                  </pre>
                )}
              </>
            )}
          </div>
        )}

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
          disabled={isCommitting || needsIdentity || !title.trim()}
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
