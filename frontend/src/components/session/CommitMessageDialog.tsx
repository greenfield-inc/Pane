import React, { useCallback, useEffect, useState } from 'react';
import { composeCommitMessage, isCommitSubmitShortcut, splitCommitMessage } from '../../../../shared/utils/commitMessage';
import type { GitCommands } from '../../types/session';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../../stores/configStore';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Checkbox, Input, Textarea } from '../ui/Input';
import { Card } from '../ui/Card';

interface CommitMessageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  dialogType: 'squash' | 'rebase' | 'commit';
  gitCommands: GitCommands | null;
  commitMessage?: string;
  shouldSquash: boolean;
  setShouldSquash: (should: boolean) => void;
  onConfirm: (message: string) => void;
  onMergeAndArchive?: (message: string) => void;
  isMerging: boolean;
  isMergingAndArchiving?: boolean;
}

export const CommitMessageDialog: React.FC<CommitMessageDialogProps> = ({
  isOpen,
  onClose,
  dialogType,
  gitCommands,
  commitMessage = '',
  shouldSquash,
  setShouldSquash,
  onConfirm,
  onMergeAndArchive,
  isMerging,
  isMergingAndArchiving,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const isProcessing = isMerging || isMergingAndArchiving;
  const isMessageDisabled = dialogType === 'squash' && !shouldSquash;
  const isMessageRequired = dialogType === 'commit' || shouldSquash;
  const composedMessage = composeCommitMessage(title, description);
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));
  const canConfirm = !isProcessing && (!isMessageRequired || !!title.trim());

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isCommitSubmitShortcut(event, keyboardShortcutsEnabled, canConfirm)) {
      event.preventDefault();
      onConfirm(composedMessage);
    }
  }, [canConfirm, composedMessage, keyboardShortcutsEnabled, onConfirm]);

  useEffect(() => {
    if (!isOpen) return;

    const parts = splitCommitMessage(commitMessage);
    setTitle(parts.title);
    setDescription(parts.description);
  }, [commitMessage, isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader
        title={dialogType === 'commit'
          ? 'Commit Changes'
          : dialogType === 'squash'
            ? `Merge to ${gitCommands?.comparisonBaseBranch || 'Main'}`
            : `Rebase from ${gitCommands?.comparisonBaseBranch || 'Main'}`}
      />
      
      <ModalBody>
          <div className="space-y-4" onKeyDown={handleKeyDown}>
            {dialogType === 'squash' && (
              <Card variant="bordered" padding="md" className="bg-surface-secondary">
                <div className="flex items-center space-x-3">
                  <Checkbox
                    id="shouldSquash"
                    label="Squash commits into one"
                    checked={shouldSquash}
                    onChange={(e) => setShouldSquash(e.target.checked)}
                    className="flex-1"
                  />
                  <div className="text-sm text-text-secondary ml-6">
                    {shouldSquash ? "Combine all commits into a single commit before merging" : "Keep all commits and preserve history"}
                  </div>
                </div>
              </Card>
            )}
            
            <Input
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isMessageDisabled}
              placeholder={isMessageDisabled ? "Not needed when preserving commits" : "Enter commit title..."}
              fullWidth
            />

            <Textarea
              label="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              disabled={isMessageDisabled}
              placeholder={isMessageDisabled ? "Not needed when preserving commits" : "Add more details..."}
              helperText={
                dialogType === 'commit'
                  ? 'All changes will be staged and committed.'
                  : dialogType === 'squash'
                    ? (shouldSquash
                        ? `This message will be used for the merge commit.`
                        : `Original commit messages will be preserved when merging.`)
                    : `This message will be used when rebasing.`
              }
              fullWidth
              className="font-mono text-sm"
            />

            {dialogType === 'squash' && (
              <Card variant="bordered" padding="md" className="bg-surface-secondary">
                <h4 className="text-sm font-medium text-text-primary mb-2">Git commands to be executed:</h4>
                <div className="space-y-1">
                  {shouldSquash ? (
                    gitCommands?.squashCommands?.map((cmd, idx) => (
                      <Card key={idx} variant="bordered" padding="sm" className="bg-surface-tertiary text-text-primary font-mono text-xs">
                        {cmd}
                      </Card>
                    ))
                  ) : (
                    gitCommands?.mergeCommands?.map((cmd, idx) => (
                      <Card key={idx} variant="bordered" padding="sm" className="bg-surface-tertiary text-text-primary font-mono text-xs">
                        {cmd}
                      </Card>
                    ))
                  )}
                </div>
              </Card>
            )}
          </div>
      </ModalBody>
      
      <ModalFooter className="flex justify-end gap-3">
        <Button onClick={onClose} variant="ghost" disabled={isProcessing}>
          Cancel
        </Button>
        {dialogType === 'squash' && onMergeAndArchive && (
          <Button
            onClick={() => onMergeAndArchive(composedMessage)}
            disabled={!canConfirm}
            loading={isMergingAndArchiving}
            variant="secondary"
          >
            {isMergingAndArchiving ? 'Merging...' : 'Merge & Archive'}
          </Button>
        )}
        <Button
          onClick={() => onConfirm(composedMessage)}
          disabled={!canConfirm}
          loading={isMerging}
        >
          {isMerging
            ? (dialogType === 'commit' ? 'Committing...' : 'Merging...')
            : (dialogType === 'commit' ? 'Commit' : (dialogType === 'squash' ? 'Merge' : 'Rebase'))
          }
        </Button>
      </ModalFooter>
    </Modal>
  );
};
