import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { Input } from './ui/Input';

export function CustomResumeFields({ value, onChange }: {
  value?: CustomCommandResume | null;
  onChange: (value: CustomCommandResume | null) => void;
}) {
  return <fieldset className="space-y-3 border-t border-border-primary pt-3">
    <label className="flex items-center gap-2 text-sm text-text-primary">
      <input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked
        ? { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' } : null)} />
      Enable custom command resume
    </label>
    {value && <>
      <label className="block text-sm text-text-primary">Session ID source
        <select className="mt-1 w-full rounded border border-border-primary bg-surface-primary p-2" value={value.mode}
          onChange={event => {
            const mode = event.target.value;
            if (mode !== 'claude' && mode !== 'codex' && mode !== 'cursor' && mode !== 'generated' && mode !== 'reported') return;
            onChange({ ...value, mode });
          }}>
          <option value="reported">CLI reports its ID</option>
          <option value="generated">Pane allocates an ID</option>
          <option value="claude">Claude (Pane allocates an ID)</option>
          <option value="codex">Codex (capture from terminal)</option>
          <option value="cursor">Cursor (capture from terminal)</option>
        </select>
      </label>
      <Input label="First launch template" value={value.initialTemplate}
        onChange={event => onChange({ ...value, initialTemplate: event.target.value })} fullWidth />
      <Input label="Resume template" value={value.resumeTemplate}
        onChange={event => onChange({ ...value, resumeTemplate: event.target.value })} fullWidth />
      <p className="text-xs text-text-secondary">Use {'{command}'} for your command and {'{sessionId}'} for the ID. Pane quotes the ID; leave that placeholder unquoted. Allocated IDs require it in the first launch template too.</p>
      {value.mode === 'reported' && <p className="text-xs text-text-secondary">Your CLI must print a separate line: PANE_AGENT_SESSION_ID=your-session-id</p>}
    </>}
  </fieldset>;
}
