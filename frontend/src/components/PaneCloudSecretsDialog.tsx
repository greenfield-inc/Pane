import { useEffect, useState } from 'react';
import { Monitor, Server } from 'lucide-react';
import { EMPTY_PANE_CLOUD_SECRET_CHOICE, sendsToCloud, type PaneCloudSecretChoice, type PaneCloudSecretMachine } from '../../../shared/types/paneCloudSecrets';
import { cn } from '../utils/cn';
import { isMac } from '../utils/platformUtils';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';

const THIS_COMPUTER = isMac() ? 'This Mac' : 'This computer';
const CHECKBOX = 'h-3.5 w-3.5 shrink-0 rounded border-border-primary accent-interactive';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Toggles `item` in `list`. */
const toggled = (list: readonly string[], item: string, on: boolean) => (on ? list.filter((entry) => entry !== item) : [...list, item]);

/** The footer line: how many secrets the choice sends, and from how many machines. */
function secretChoiceSummary(machines: readonly PaneCloudSecretMachine[], choice: PaneCloudSecretChoice): string {
  const total = machines.reduce((sum, machine) => sum + machine.secrets.length, 0);
  const sent = machines.map((machine) => machine.secrets.filter((secret) => sendsToCloud(choice, secret.key, machine.name)).length);
  return `${sent.reduce((sum, count) => sum + count, 0)} of ${plural(total, 'secret')}, from ${sent.filter((count) => count > 0).length} of ${plural(machines.length, 'machine')}`;
}

type Loaded = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; machines: PaneCloudSecretMachine[] };

/**
 * "Choose what to send" (frame B2): the person's paired machines and the secrets last set on each,
 * by name only, all on to start. Done remembers the choice for every cloud Session.
 */
export function PaneCloudSecretsDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [choice, setChoice] = useState<PaneCloudSecretChoice>(EMPTY_PANE_CLOUD_SECRET_CHOICE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let current = true;
    setLoaded({ state: 'loading' });
    setSaveError(null);
    void window.electronAPI.paneCloud.secrets().then((response) => {
      if (!current) return;
      if (!response.success || !response.data) {
        setLoaded({ state: 'failed', error: response.error ?? 'Pane could not list your secrets.' });
        return;
      }
      setChoice(response.data.choice);
      setLoaded({ state: 'ready', machines: response.data.machines });
    }, (failure: Error) => {
      if (current) setLoaded({ state: 'failed', error: failure.message || 'Pane could not list your secrets.' });
    });
    return () => { current = false; };
  }, [isOpen]);

  const done = async () => {
    setSaving(true);
    try {
      const response = await window.electronAPI.paneCloud.chooseSecrets(choice);
      if (!response.success) {
        setSaveError(response.error ?? 'Pane could not save your choice.');
        return;
      }
      onClose();
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : 'Pane could not save your choice.');
    } finally {
      setSaving(false);
    }
  };

  const machines = loaded.state === 'ready' ? loaded.machines : [];
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" ariaLabel="Choose what to send">
      <ModalHeader title="Choose what to send" description="Everything is on to start. Turn off a secret or a whole machine." />
      <ModalBody className="space-y-3">
        {loaded.state === 'loading' && <p className="text-sm text-text-secondary">Reading your secrets…</p>}
        {loaded.state === 'failed' && <p className="text-sm text-status-error">{loaded.error}</p>}
        {loaded.state === 'ready' && machines.length === 0 && (
          <p className="text-sm text-text-secondary">No secrets to send yet. Add them in Settings, Secrets, and they come along to new cloud Sessions.</p>
        )}
        {machines.length > 0 && (
          <div className="overflow-hidden rounded border border-border-primary bg-surface-secondary" data-testid="pane-cloud-secrets">
            {machines.map((machine, index) => (
              <MachineGroup key={machine.name} machine={machine} choice={choice} onChange={setChoice} first={index === 0} />
            ))}
          </div>
        )}
        <p className="text-xs text-text-secondary">
          Your computer sends them to each cloud machine encrypted end to end: Greenfield&apos;s relay passes them along and can&apos;t read them. There they&apos;re kept on a separate volume the checks don&apos;t read. Turning one off also removes it from cloud Sessions that already have it, the next time one of your computers reaches them. Pane remembers this choice for every cloud Session.
        </p>
        {saveError && <p className="text-xs text-status-error">{saveError}</p>}
      </ModalBody>
      <ModalFooter className="justify-between">
        <span className="text-xs text-text-tertiary" data-testid="pane-cloud-secrets-summary">{machines.length > 0 ? secretChoiceSummary(machines, choice) : ''}</span>
        <span className="flex items-center gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => void done()} disabled={loaded.state !== 'ready' || saving}>Done</Button>
        </span>
      </ModalFooter>
    </Modal>
  );
}

function MachineGroup({ machine, choice, onChange, first }: { machine: PaneCloudSecretMachine; choice: PaneCloudSecretChoice; onChange: (choice: PaneCloudSecretChoice) => void; first: boolean }) {
  const on = !choice.excludedMachines.includes(machine.name);
  const Icon = machine.thisComputer ? Monitor : Server;
  const detail = [machine.thisComputer ? THIS_COMPUTER : 'Paired', plural(machine.secrets.length, 'secret'), ...(on ? [] : ['left out'])].join(' · ');
  return (
    <div role="group" aria-label={machine.name} className={cn(!first && 'border-t border-border-primary')}>
      <label className="flex items-center gap-3 bg-surface-tertiary px-3 py-2.5 text-sm">
        <input type="checkbox" className={CHECKBOX} checked={on} aria-label={`Send ${machine.name}'s secrets`}
          onChange={(event) => onChange({ ...choice, excludedMachines: toggled(choice.excludedMachines, machine.name, event.target.checked) })} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{machine.name}</span>
        <span className="shrink-0 text-xs text-text-tertiary">{detail}</span>
      </label>
      {on && machine.secrets.map((secret) => {
        const sent = !choice.excludedSecrets.includes(secret.key);
        return (
          <label key={secret.key} className="flex items-center gap-3 border-t border-border-primary py-2 pl-10 pr-3 text-xs">
            <input type="checkbox" className={CHECKBOX} checked={sent} aria-label={`Send ${secret.name} (${secret.label})`}
              onChange={(event) => onChange({ ...choice, excludedSecrets: toggled(choice.excludedSecrets, secret.key, event.target.checked) })} />
            <span className={cn('min-w-0 flex-1 truncate font-mono', sent ? 'text-text-primary' : 'text-text-tertiary')}>{secret.name}</span>
            <span className={cn('shrink-0', sent ? 'text-text-secondary' : 'text-text-tertiary')}>{sent ? secret.label : 'Left out'}</span>
          </label>
        );
      })}
    </div>
  );
}
