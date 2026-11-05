import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, KeyRound, Plus } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { SecretValueInput } from '../../ui/SecretValueInput';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { formatDistanceToNow } from '../../../utils/timestampUtils';
import {
  paneSecretKey,
  paneSecretNameProblem,
  paneSecretProjectProblem,
  type PaneSecretStorage,
  type PaneSecretSummary,
} from '../../../../../shared/types/paneSecrets';

type Listing = { secrets: PaneSecretSummary[]; storage: PaneSecretStorage };

/** A masked value field with Save and Cancel. The typed value leaves state once it is sent. */
function ValueForm({ label, onSave, onCancel }: { label: string; onSave: (value: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value) return;
    setBusy(true);
    const sent = value;
    setValue('');
    await onSave(sent);
    setBusy(false);
  };
  return (
    <form className="flex items-center gap-2" onSubmit={(event) => void submit(event)}>
      <div className="min-w-0 flex-1">
        <SecretValueInput
          autoFocus
          aria-label={label}
          placeholder="New value"
          value={value}
          onValueChange={setValue}
          className="w-full font-mono text-sm"
        />
      </div>
      <Button type="submit" size="sm" disabled={!value || busy}>Save</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

function SecretRow({ secret, onSet, onDelete }: {
  secret: PaneSecretSummary;
  onSet: (value: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<'idle' | 'replace' | 'confirm-delete'>('idle');
  const address = paneSecretKey(secret.project, secret.name);
  return (
    <div className="py-3" data-testid="pane-secret-row" data-secret={address}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-text-primary">{secret.name}</span>
        <span className="font-mono text-xs tracking-widest text-text-muted" aria-hidden="true">••••••••</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
          Set on {secret.machine} {formatDistanceToNow(secret.updatedAt)}
        </span>
        {mode === 'idle' && (
          <span className="flex shrink-0 gap-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setMode('replace')}>Replace</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('confirm-delete')}>Delete</Button>
          </span>
        )}
      </div>
      {mode === 'replace' && (
        <div className="mt-2">
          <ValueForm
            label={`New value for ${address}`}
            onSave={async (value) => {
              const saved = await onSet(value);
              if (saved) setMode('idle');
              return saved;
            }}
            onCancel={() => setMode('idle')}
          />
        </div>
      )}
      {mode === 'confirm-delete' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-secondary px-3 py-2 text-sm text-text-secondary" role="group" aria-label={`Delete ${address}`}>
          <span className="min-w-0 flex-1">Delete {address} from all your machines? Agents that use it stop getting it.</span>
          <Button type="button" variant="danger" size="sm" onClick={() => void onDelete().then((deleted) => { if (!deleted) setMode('idle'); })}>Delete</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setMode('idle')}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

function AddSecretForm({ onAdd, onCancel }: { onAdd: (project: string, name: string, value: string) => Promise<boolean>; onCancel: () => void }) {
  const [project, setProject] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const projectProblem = project ? paneSecretProjectProblem(project.trim()) : null;
  const nameProblem = name ? paneSecretNameProblem(name.trim()) : null;
  const ready = project.trim() && name.trim() && value && !projectProblem && !nameProblem;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const sent = value;
    setValue('');
    const added = await onAdd(project.trim(), name.trim(), sent);
    setBusy(false);
    if (added) onCancel();
  };
  return (
    <form className="space-y-2 rounded-md border border-border-secondary p-3" onSubmit={(event) => void submit(event)} aria-label="Add a secret">
      <div className="flex flex-wrap gap-2">
        <div className="min-w-[10rem] flex-1">
          <Input aria-label="Secret project" placeholder="Project, e.g. stripe" value={project} onChange={(event) => setProject(event.target.value)} error={projectProblem ?? undefined} className="font-mono text-sm" autoFocus fullWidth />
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input aria-label="Secret name" placeholder="NAME, e.g. STRIPE_SECRET_KEY" value={name} onChange={(event) => setName(event.target.value)} error={nameProblem ?? undefined} className="font-mono text-sm" fullWidth />
        </div>
      </div>
      <SecretValueInput aria-label="Secret value" placeholder="Value" value={value} onValueChange={setValue} className="font-mono text-sm" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!ready || busy}>Save securely</Button>
      </div>
    </form>
  );
}

/** Settings → Secrets: this computer's Pane secrets. Values go in only; none is ever shown. */
export function SecretsSettings() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    const response = await window.electronAPI.paneSecrets.list().catch((err: Error) => ({ success: false as const, error: err.message, data: undefined }));
    if (response.success && response.data) {
      setListing(response.data);
    } else {
      setError(response.error || 'Pane could not list your secrets.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /** Runs one change, shows its error, and reloads the list. True when it worked. */
  const run = async (change: () => Promise<{ success: boolean; error?: string }>, failure: string): Promise<boolean> => {
    setError(null);
    const response = await change().catch((err: Error) => ({ success: false, error: err.message }));
    if (!response.success) setError(response.error || failure);
    await refresh();
    return response.success;
  };
  const set = (project: string, name: string, value: string) =>
    run(() => window.electronAPI.paneSecrets.set(project, name, value), `Pane could not save ${paneSecretKey(project, name)}.`);
  const remove = (project: string, name: string) =>
    run(() => window.electronAPI.paneSecrets.delete(project, name), `Pane could not delete ${paneSecretKey(project, name)}.`);

  const projects = new Map<string, PaneSecretSummary[]>();
  for (const secret of [...(listing?.secrets ?? [])].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name))) {
    projects.set(secret.project, [...(projects.get(secret.project) ?? []), secret]);
  }

  return (
    <SettingsPage title="Secrets" description="Values your agents asked for or you added, synced to every machine you saved in Pane.">
      <div id={settingDomId('pane-secrets')} data-setting-id="pane-secrets" tabIndex={-1} className="space-y-6 outline-none">
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">
            Any agent on your machines can use these with <code className="font-mono text-text-primary">runpane secrets exec</code>. Values are never shown again.
          </p>
          {listing && !listing.storage.encrypted && (
            <p className="flex items-center gap-1.5 text-sm text-status-warning" data-testid="pane-secrets-unencrypted">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Stored unencrypted on this host (no OS keyring).
            </p>
          )}
          {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
        </div>

        {adding ? (
          <AddSecretForm onAdd={set} onCancel={() => setAdding(false)} />
        ) : (
          <Button type="button" variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add secret
          </Button>
        )}

        {listing && projects.size === 0 && (
          <p className="text-sm text-text-tertiary">No secrets yet. When an agent asks you for one, or you add one, it shows here.</p>
        )}
        {[...projects].map(([project, secrets]) => (
          <SettingsSection key={project} title={project} icon={<KeyRound className="h-4 w-4" />} spacing="sm">
            <div className="divide-y divide-border-secondary">
              {secrets.map((secret) => (
                <SecretRow
                  key={secret.name}
                  secret={secret}
                  onSet={(value) => set(secret.project, secret.name, value)}
                  onDelete={() => remove(secret.project, secret.name)}
                />
              ))}
            </div>
          </SettingsSection>
        ))}
      </div>
    </SettingsPage>
  );
}
