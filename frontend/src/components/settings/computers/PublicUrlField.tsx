import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';

/** This computer's own HTTPS address (a reverse proxy in front of Pane); its linked computers add it as a route. */
export function PublicUrlField({ saved, onSaved }: { saved: string; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? saved;
  const changed = value.trim() !== saved;

  const save = async (url: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.invoke('computers:set-public-url', { url });
      await onSaved();
      setDraft(null);
    } catch (cause) {
      setError(ipcErrorMessage(cause, "Pane couldn't save the address. Nothing changed; try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-1.5 pb-4 pl-[60px] pr-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) void save(value.trim() || null);
      }}
    >
      <label htmlFor="remote-public-url" className="block text-xs font-medium text-text-secondary">Public URL</label>
      <div className="flex items-center gap-2">
        <Input
          id="remote-public-url"
          placeholder="https://pane.example.com"
          className="w-72 text-sm"
          value={value}
          onChange={(event) => { setDraft(event.target.value); setError(null); }}
        />
        <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!changed}>Save</Button>
        {saved && !changed && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>Clear</Button>
        )}
      </div>
      {error
        ? <p className="text-xs text-status-error" role="alert">{error}</p>
        : <p className="text-xs text-text-tertiary">Linked computers find it automatically.</p>}
    </form>
  );
}
