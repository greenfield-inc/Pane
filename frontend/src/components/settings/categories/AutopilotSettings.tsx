import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AutopilotInstructionsView } from '../../../../../shared/types/autopilot';
import { showActionError } from '../../../stores/errorStore';
import { useAutopilotStore } from '../../../stores/autopilotStore';
import { Button } from '../../ui/Button';
import { SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { cn } from '../../../utils/cn';

const GROUP = 'rounded-2xl bg-surface-primary p-4 shadow-card ring-1 ring-border-secondary';

/** What the badge beside the box says (D-196). */
function instructionsStatusLabel(view: Pick<AutopilotInstructionsView, 'status'>, dirty: boolean): string {
  if (dirty) return 'Not saved';
  if (view.status === 'applied') return 'Applied';
  if (view.status === 'next-start') return 'Applies on next Start';
  return 'None yet';
}

/**
 * Settings › Autopilot (D-196): the person's own instructions for Autopilot, kept in a plain file
 * on this machine that they, the CLI and Autopilot (with their approval) can edit too.
 */
export function AutopilotSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [view, setView] = useState<AutopilotInstructionsView | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const snapshot = useAutopilotStore((state) => state.snapshot);
  const dirty = view !== null && draft.trim() !== view.text;
  const latest = useRef({ view, draft });
  latest.current = { view, draft };

  // Reload on every Autopilot change (Start, a stop, an edit to the file that reached the agent); a draft in progress stays.
  useEffect(() => {
    let live = true;
    window.electronAPI.autopilot.instructions()
      .then((next) => {
        if (!live) return;
        const { view: previous, draft: current } = latest.current;
        if (previous === null || current.trim() === previous.text) setDraft(next.text);
        setView(next);
      })
      .catch((error: Error) => showActionError('Could not read your Autopilot instructions', error));
    return () => { live = false; };
  }, [snapshot]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const save = (text: string, action: string) => {
    setSaving(true);
    window.electronAPI.autopilot.setInstructions(text)
      .then((next) => { setView(next); setDraft(next.text); })
      .catch((error: Error) => showActionError(action, error))
      .finally(() => setSaving(false));
  };

  const status = view ? instructionsStatusLabel(view, dirty) : '';
  return (
    <SettingsPage title="Autopilot" description="Tell Autopilot how you want it to work. It reads your instructions after Pane's own.">
      <section id={settingDomId('autopilot-instructions')} data-setting-id="autopilot-instructions" tabIndex={-1} className={cn(GROUP, 'space-y-3 outline-none')}>
        <div className="flex items-center gap-2">
          <label htmlFor="autopilot-instructions-text" className="text-sm font-medium text-text-primary">Your instructions</label>
          {view && (
            <span
              data-testid="autopilot-instructions-status"
              className={cn(
                'ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium',
                !dirty && view.status === 'applied' ? 'bg-autopilot-subtle text-autopilot-on-tint' : 'bg-surface-tertiary text-text-secondary',
              )}
            >
              {status}
            </span>
          )}
        </div>
        <textarea
          id="autopilot-instructions-text"
          data-testid="autopilot-instructions-text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!view || saving}
          rows={8}
          placeholder={'For example:\nGroup things by repo.\nAlways ask before closing anything.\nBe brief.\nFocus on Bloom first.'}
          className="block w-full resize-y rounded-lg border border-border-primary bg-bg-primary px-3 py-2 font-mono text-[13px] leading-relaxed text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-focus-ring-subtle disabled:opacity-60"
        />
        <p className="text-xs leading-relaxed text-text-tertiary">
          These shape how Autopilot works: what it brings first, how it groups things, how it talks. They can't override its hard limits:
          it never answers an approval or a permission prompt, and never merges, deletes, pushes or closes anything without your word.
          {snapshot?.state && snapshot.state !== 'stopped'
            ? ' Saving sends them to Autopilot now.'
            : ' They apply the next time you press Start.'}
        </p>
        {view && (
          <p className="text-xs text-text-tertiary">
            Saved in <code className="font-mono text-text-secondary">{view.path}</code> on this computer. Edit that file directly if you like;
            in Autopilot's chat you can also say "from now on, …" and it offers to add the line for your approval.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => save(draft, 'Could not save your Autopilot instructions')}>
            Save
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={!view || saving || (!view.text && !draft.trim())} onClick={() => save('', 'Could not reset your Autopilot instructions')}>
            Reset
          </Button>
          <button
            type="button"
            data-testid="autopilot-builtin-toggle"
            aria-expanded={showBuiltIn}
            onClick={() => setShowBuiltIn((open) => !open)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            {showBuiltIn ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            View built-in instructions
          </button>
        </div>
        {showBuiltIn && view && (
          <pre
            data-testid="autopilot-builtin"
            aria-label="Pane's built-in instructions for Autopilot (read-only)"
            className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-secondary p-3 font-mono text-[12px] leading-relaxed text-text-secondary"
          >
            {view.builtIn}
          </pre>
        )}
      </section>
    </SettingsPage>
  );
}
