import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LibraryProfile } from '../../../../shared/types/profiles';
import { API } from '../../utils/api';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Input, Textarea } from '../ui/Input';
import { Button } from '../ui/Button';
import { chatTabProfileLaunch, type ChatTabProfileLaunch } from '../../../../shared/chatTabProfileLaunch';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

interface AgentFarmProfileDialogProps {
  onClose: () => void;
  /** Creates the chat tab on the Pane's host; a rejection keeps the dialog open with the host's reason. */
  onCreate: (launch: ChatTabProfileLaunch) => Promise<void>;
  /** Desktop: opens Launch for one of Pane's profiles. Without it the dialog lists none (the phone launches later). */
  onLaunchProfile?: (profile: LibraryProfile) => void;
}

/**
 * "Profile…" in the + menu and the PWA's Add Tool. On the desktop it lists Pane's profiles that
 * are on, each launched with its workflow; below, any Agent Farm profile by name opens as a chat
 * tab, as `runpane panels create --agent-farm <profile> --arg key=value` does. That name is typed:
 * `agent-farm profiles list` prints no machine-readable list.
 */
export function AgentFarmProfileDialog({ onClose, onCreate, onLaunchProfile }: AgentFarmProfileDialogProps) {
  const [paneProfiles, setPaneProfiles] = useState<LibraryProfile[]>([]);
  useEffect(() => {
    if (!onLaunchProfile) return;
    let cancelled = false;
    void API.profiles.list().then((response) => {
      if (!cancelled && response.success && response.data) setPaneProfiles(response.data.profiles.filter((profile) => profile.enabled && profile.launchable));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [onLaunchProfile]);
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
    <Modal isOpen onClose={onClose} size="sm" ariaLabel="Profile" initialFocusRef={profileRef} showCloseButton={false}>
      <form onSubmit={event => void submit(event)} className="flex min-h-0 flex-col">
        <ModalHeader title="Profile" description="Launch one of Pane's profiles, or open an Agent Farm profile as a chat tab on this Pane's machine." onClose={onClose} />
        <ModalBody className="space-y-4">
          {paneProfiles.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="profile-picker-list">
              <p className="text-xs text-text-secondary">Pane profiles</p>
              {paneProfiles.map((paneProfile) => (
                <button key={paneProfile.name} type="button" onClick={() => onLaunchProfile?.(paneProfile)} className="flex flex-col rounded-md border border-border-primary px-3 py-2 text-left hover:bg-surface-hover">
                  <span className="text-[13px] font-medium text-text-primary">{paneProfile.name}</span>
                  {paneProfile.title && <span className="text-xs text-text-secondary">{paneProfile.title}</span>}
                </button>
              ))}
              <p className="pt-2 text-xs text-text-secondary">Or an Agent Farm profile, by name</p>
            </div>
          )}
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
