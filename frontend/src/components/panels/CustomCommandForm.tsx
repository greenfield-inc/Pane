import { CustomResumeFields } from '../CustomResumeFields';
import { validateCustomCommandResume, type CustomCommandResume } from '../../../../shared/types/customCommandResume';
import { useEffect, useRef, useState } from 'react';

interface CustomCommandFormProps {
  existing?: { name: string; command: string; resume?: CustomCommandResume | null };
  onSave: (name: string, command: string, resume: CustomCommandResume | null) => Promise<void>;
  onCancel: () => void;
}

export function CustomCommandForm({ existing, onSave, onCancel }: CustomCommandFormProps) {
  const [resume, setResume] = useState<CustomCommandResume | null>(existing?.resume ?? null);
  const [name, setName] = useState(existing?.name ?? '');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const inputClass = 'w-full px-2 py-1.5 text-sm bg-surface-secondary border border-border-primary rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus';

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  return (
    <form
      className="px-3 py-2 border-b border-border-primary space-y-2"
      aria-label={existing ? 'Rename profile' : 'Add custom command'}
      onKeyDown={(event) => {
        // Keep typing and Tab navigation inside the form out of the menu handler.
        event.stopPropagation();
        if (event.key === 'Escape' && !saving) {
          event.preventDefault();
          onCancel();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving || !command.trim() || (existing && !name.trim())) return;
        setSaving(true);
        setError(null);
        try {
          if (resume) validateCustomCommandResume(resume);
          await onSave(name.trim() || command.trim().split(/\s+/).slice(0, 3).join(' '), command.trim(), resume);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Could not save profile. Please try again.');
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="text-xs text-text-tertiary block">
        {existing ? 'Name' : 'Name (optional)'}
        <input ref={nameRef} className={inputClass} value={name} disabled={saving}
          placeholder="e.g. Planner" onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="text-xs text-text-tertiary block">
        Command to run
        <input className={inputClass} value={command} readOnly={!!existing} disabled={saving}
          placeholder="e.g. aider, npm run dev, bash" onChange={(event) => setCommand(event.target.value)} />
      </label>
      <CustomResumeFields value={resume} onChange={setResume} />
      {error && <p role="alert" className="text-xs text-text-primary">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="px-2 py-1 text-sm rounded hover:bg-surface-hover" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="submit" className="px-2 py-1 text-sm rounded bg-surface-secondary hover:bg-surface-hover disabled:opacity-50"
          disabled={saving || !command.trim() || (!!existing && !name.trim())}>
          {existing ? 'Save name' : 'Save & launch'}
        </button>
      </div>
    </form>
  );
}
