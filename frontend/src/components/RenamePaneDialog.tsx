import { useRef, useState } from 'react';
import type { Session } from '../types/session';
import { API } from '../utils/api';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';

interface RenamePaneDialogProps {
  session: Session | null;
  onClose: () => void;
}

export function RenamePaneDialog({ session, onClose }: RenamePaneDialogProps) {
  if (!session) return null;
  return <RenamePaneDialogBody key={session.id} session={session} onClose={onClose} />;
}

function RenamePaneDialogBody({ session, onClose }: { session: Session; onClose: () => void }) {
  const [name, setName] = useState(session.name ?? '');
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const didSelectInitialName = useRef(false);
  const trimmedName = name.trim();

  const submit = async () => {
    if (!trimmedName || isSaving) return;
    setIsSaving(true);
    setError(undefined);
    try {
      const response = await API.sessions.rename(session.id, trimmedName);
      if (!response.success) {
        setError(response.error || 'Failed to rename pane');
        return;
      }
      onClose();
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Failed to rename pane');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      ariaLabel="Rename pane"
      initialFocusRef={inputRef}
      restoreFocusOnClose={false}
    >
      <ModalHeader title="Rename pane" onClose={onClose} />
      <ModalBody>
        <EnhancedInput
          ref={inputRef}
          onFocus={(event) => {
            if (didSelectInitialName.current) return;
            didSelectInitialName.current = true;
            event.currentTarget.select();
          }}
          label="Pane name"
          value={name}
          error={error ?? (!trimmedName ? 'Pane name cannot be blank' : undefined)}
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={isSaving}>Cancel</Button>
        <Button onClick={() => void submit()} disabled={!trimmedName || isSaving} loading={isSaving}>Save</Button>
      </ModalFooter>
    </Modal>
  );
}
