import { useRef, useState, type FormEvent } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Input, Textarea } from '../ui/Input';
import { Button } from '../ui/Button';
import { chatTabProfileLaunch, type ChatTabProfileLaunch } from '../../../../shared/chatTabProfileLaunch';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

interface AgentFarmProfileDialogProps {
  onClose: () => void;
  /** Creates the chat tab on the Pane's host; a rejection keeps the dialog open with the host's reason. */
  onCreate: (launch: ChatTabProfileLaunch) => Promise<void>;
}

/**
 * "Agent Farm profile…" in the + menu and the PWA's Add Tool: a chat tab launched from
 * a profile, as `runpane panels create --agent-farm <profile> --arg key=value` does.
 * The profile is typed: `agent-farm profiles list` prints no machine-readable list.
 */
export function AgentFarmProfileDialog({ onClose, onCreate }: AgentFarmProfileDialogProps) {
  const [profile, setProfile] = useState('');
  const [args, setArgs] = useState('');
  const [problem, setProblem] = useState<{ field: 'profile' | 'args' | 'host'; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const profileRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = chatTabProfileLaunch(profile, args);
    if (!parsed.ok) { setProblem({ field: parsed.field, error: parsed.error }); return; }
    setBusy(true);
    setProblem(null);
    try {
      await onCreate(parsed.launch);
      onClose();
    } catch (error) {
      setProblem({ field: 'host', error: ipcErrorMessage(error, 'The chat tab was not created.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="sm" ariaLabel="Agent Farm profile" initialFocusRef={profileRef} showCloseButton={false}>
      <form onSubmit={event => void submit(event)} className="flex min-h-0 flex-col">
        <ModalHeader title="Agent Farm profile" description="Opens a chat tab running the profile on this Pane's machine." onClose={onClose} />
        <ModalBody className="space-y-4">
          <Input ref={profileRef} label="Profile" fullWidth value={profile} placeholder="greenfield/implementer" autoComplete="off" spellCheck={false}
            onChange={event => setProfile(event.target.value)} error={problem?.field === 'profile' ? problem.error : undefined}
            helperText="A name from agent-farm profiles list." />
          <Textarea label="Arguments (optional)" fullWidth rows={3} value={args} placeholder="ticket=PANE-12" spellCheck={false}
            onChange={event => setArgs(event.target.value)} error={problem?.field === 'args' ? problem.error : undefined}
            helperText="One key=value per line, passed as --arg." className="font-mono text-sm" />
          {problem?.field === 'host' && <p role="alert" className="text-sm text-status-error">{problem.error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Opening…' : 'Open chat'}</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
