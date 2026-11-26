import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Input, Textarea } from '../ui/Input';
import { Button } from '../ui/Button';
import { chatTabProfileLaunch, chatTabProfileOptions, type ChatTabProfileLaunch, type ChatTabProfileOption } from '../../../../shared/chatTabProfileLaunch';
import type { AgentFarmProfileList } from '../../../../shared/types/agentFarmProfiles';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';

interface AgentFarmProfileDialogProps {
  onClose: () => void;
  /** Creates the chat tab on the Pane's host; a rejection keeps the dialog open with the host's reason. */
  onCreate: (launch: ChatTabProfileLaunch) => Promise<void>;
}

/** The picker's profiles: read from Agent Farm's list, or why they couldn't be (then the name is typed). */
type ProfileRead = { state: 'reading' } | { state: 'read'; options: ChatTabProfileOption[] } | { state: 'typed'; reason?: string };

/**
 * This computer's profiles for the picker, through the chat-tab `profiles` channel New Session uses.
 * Only with the Profiles switch on and in the desktop app; otherwise the name is typed, as before.
 */
function useProfileOptions(enabled: boolean): ProfileRead {
  const [read, setRead] = useState<ProfileRead>(() => (enabled ? { state: 'reading' } : { state: 'typed' }));
  useEffect(() => {
    const request = enabled ? window.electronAPI?.chatTab?.profiles?.() : undefined;
    if (!request) { setRead({ state: 'typed' }); return undefined; }
    let live = true;
    request.then(
      (list: AgentFarmProfileList) => {
        if (!live) return;
        const options = chatTabProfileOptions(list.profiles);
        setRead(options.length ? { state: 'read', options } : { state: 'typed', reason: list.error ?? 'Agent Farm lists no profiles here. Type a profile name.' });
      },
      (cause: unknown) => { if (live) setRead({ state: 'typed', reason: ipcErrorMessage(cause, 'Pane could not read this computer’s profiles. Type a profile name.') }); },
    );
    return () => { live = false; };
  }, [enabled]);
  return read;
}

/**
 * "Profile…" in the + menu and the PWA's Add Tool: an Agent Farm profile opens as a chat tab, as
 * `runpane panels create --agent-farm <profile> --arg key=value` does. With Profiles on (T-83) it is
 * picked from `agent-farm profiles list --json`, by title and ref, Pane's own left out; with Profiles
 * off, in the PWA, or when the list can't be read, the name is typed.
 */
export function AgentFarmProfileDialog({ onClose, onCreate }: AgentFarmProfileDialogProps) {
  const profilesOn = useConfigStore(state => isProfilesEnabled(state.config));
  const read = useProfileOptions(profilesOn);
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState('');
  const [args, setArgs] = useState('');
  const [problem, setProblem] = useState<{ field: 'profile' | 'args' | 'host'; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const typedRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLSelectElement>(null);
  const options = read.state === 'read' ? read.options : null;
  const profile = options ? (picked || options[0].ref) : typed;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (read.state === 'reading') return;
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

  const profileError = problem?.field === 'profile' ? problem.error : undefined;
  return (
    <Modal isOpen onClose={onClose} size="sm" ariaLabel="Profile" initialFocusRef={options ? pickerRef : typedRef} showCloseButton={false}>
      <form onSubmit={event => void submit(event)} className="flex min-h-0 flex-col">
        <ModalHeader title="Profile" description="Open an Agent Farm profile as a chat tab on this Pane's machine." onClose={onClose} />
        <ModalBody className="space-y-4">
          {read.state === 'reading' && (
            // The same height as the picker, so the form doesn't jump when the list arrives.
            <div data-testid="agent-farm-profile-reading">
              <span className="mb-1 block text-label font-medium text-text-primary">Profile</span>
              <div className="flex h-9 items-center rounded-input border border-border-primary px-input-x text-sm text-text-muted">Reading profiles…</div>
            </div>
          )}
          {options && (
            <div>
              <label htmlFor="agent-farm-profile-picker" className="mb-1 block text-label font-medium text-text-primary">Profile</label>
              <select
                id="agent-farm-profile-picker"
                ref={pickerRef}
                data-testid="agent-farm-profile-picker"
                value={profile}
                onChange={event => setPicked(event.target.value)}
                className="h-9 w-full rounded-input border border-border-primary bg-bg-primary px-2 text-sm text-text-primary focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-interactive"
              >
                {options.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
              </select>
              {profileError && <p className="mt-1 text-sm text-status-error">{profileError}</p>}
            </div>
          )}
          {read.state === 'typed' && (
            <Input ref={typedRef} label="Profile" fullWidth value={typed} placeholder="greenfield/orchestrator" autoComplete="off" spellCheck={false}
              onChange={event => setTyped(event.target.value)} error={profileError}
              helperText={read.reason ?? 'A name from agent-farm profiles list.'} />
          )}
          <Textarea label="Arguments (optional)" fullWidth rows={3} value={args} placeholder="ticket=PANE-12" spellCheck={false}
            onChange={event => setArgs(event.target.value)} error={problem?.field === 'args' ? problem.error : undefined}
            helperText="One key=value per line, passed as --arg." className="font-mono text-sm" />
          {problem?.field === 'host' && <p role="alert" className="text-sm text-status-error">{problem.error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || read.state === 'reading'}>{busy ? 'Opening…' : 'Open chat'}</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
