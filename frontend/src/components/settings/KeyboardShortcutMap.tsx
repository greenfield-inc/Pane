import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Kbd } from '../ui/Kbd';
import { ConfirmDialog } from '../ConfirmDialog';
import { KeyRecorder } from './KeyRecorder';
import type { KeyboardShortcutOverrides } from '../../../../shared/utils/keyboardBindings';
import type { CustomCommand, TerminalShortcut } from '../../types/config';
import { CATEGORY_LABELS, CATEGORY_ORDER, formatKeyDisplay } from '../../utils/hotkeyUtils';
import {
  filterShortcutRows,
  labelForId,
  REFERENCE_ROWS,
  SCOPE_LABELS,
  type ShortcutMap,
  type ShortcutMapRow,
} from '../../utils/shortcutMap';

interface KeyboardShortcutMapProps {
  map: ShortcutMap;
  draft: KeyboardShortcutOverrides;
  dirty: boolean;
  terminalShortcuts: readonly TerminalShortcut[];
  customCommands: readonly CustomCommand[];
  onDraftChange: (next: KeyboardShortcutOverrides) => void;
  onApply: () => void;
  /** When set, Apply is disabled and this text explains why. */
  applyBlockedReason?: string | null;
}

const STATE_LABELS = {
  'default': null,
  'customized': 'Customized',
  'unassigned': 'Unassigned',
  'invalid': 'Invalid — using default',
} satisfies Record<ShortcutMapRow['state'], string | null>;

export function KeyboardShortcutMap({
  map, draft, dirty, terminalShortcuts, customCommands, onDraftChange, onApply, applyBlockedReason = null,
}: KeyboardShortcutMapProps) {
  const [query, setQuery] = useState('');
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const visible = useMemo(() => filterShortcutRows(map.rows, query), [map.rows, query]);
  const grouped = useMemo(() => {
    const byCategory = new Map<string, ShortcutMapRow[]>();
    for (const row of visible) {
      const group = byCategory.get(row.category) ?? [];
      group.push(row);
      byCategory.set(row.category, group);
    }
    return CATEGORY_ORDER.flatMap((category) => {
      const group = byCategory.get(category);
      return group ? [{ category, rows: group }] : [];
    });
  }, [visible]);
  const conflicted = map.conflicts.length > 0;
  const sources = { terminalShortcuts, customCommands };
  const whereToEdit = (id: string) => (
    id.startsWith('terminal-shortcut-') ? ' (edit in Terminal snippets below)'
      : id.startsWith('add-tool-custom-') ? ' (custom command; remap it in its own row or in Add Tool › Custom commands)'
        : ''
  );

  const setOverride = (id: string, value: string | null) => onDraftChange({ ...draft, [id]: value });
  const removeOverride = (id: string) => {
    const next = { ...draft };
    delete next[id];
    onDraftChange(next);
  };

  return (
    <div className="w-full space-y-3">
      <Input
        icon={<Search className="h-4 w-4" />}
        aria-label="Search shortcuts"
        placeholder="Search commands or keys"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        fullWidth
      />
      <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border-secondary">
        <div role="table" aria-label="Key bindings" className="min-w-full text-sm">
          <div role="rowgroup" className="sticky top-0 z-10 bg-surface-primary">
            <div role="row" className="hidden border-b border-border-secondary px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.8fr)] sm:gap-2">
              <span role="columnheader">Command</span>
              <span role="columnheader">Shortcut</span>
              <span role="columnheader">Default</span>
              <span role="columnheader">Scope</span>
              <span role="columnheader">State</span>
            </div>
          </div>
          {grouped.length === 0 && (
            <p className="px-3 py-2 text-xs text-text-tertiary">No shortcuts match “{query}”.</p>
          )}
          {grouped.map(({ category, rows: groupRows }) => (
            <div key={category} role="rowgroup" aria-label={CATEGORY_LABELS[category]}>
              <div aria-hidden="true" className="bg-surface-secondary/60 px-3 py-1 text-[11px] font-medium text-text-tertiary">
                {CATEGORY_LABELS[category]}
              </div>
              {groupRows.map((row) => {
                const statusId = `shortcut-status-${row.id}`;
                const conflictText = row.conflicts.length > 0
                  ? `${row.effectiveChord ? formatKeyDisplay(row.effectiveChord) : 'This key'} is also bound to ${row.conflicts.map((id) => labelForId(id, sources) + whereToEdit(id)).join(', ')}`
                  : '';
                return (
                  <div
                    key={row.id}
                    role="row"
                    data-shortcut-id={row.id}
                    className="grid gap-1 border-t border-border-secondary px-3 py-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.8fr)] sm:items-center sm:gap-2"
                  >
                    <div role="cell" className="min-w-0 text-text-primary">
                      <span>{row.label}</span>
                      {row.origin === 'snippet' && (
                        <span className="ml-1 text-[11px] text-text-tertiary">Snippet — edit in Terminal snippets below</span>
                      )}
                      {conflictText && (
                        <p id={statusId} role="alert" className="mt-0.5 text-[11px] text-status-error">{conflictText}</p>
                      )}
                    </div>
                    <div role="cell" className="min-w-0">
                      {row.editable ? (
                        <KeyRecorder
                          label={row.label}
                          chord={row.effectiveChord}
                          defaultChord={row.defaultChord}
                          customized={row.state !== 'default'}
                          describedBy={conflictText ? statusId : undefined}
                          onRecord={(chord) => setOverride(row.id, chord)}
                          onUnassign={() => setOverride(row.id, null)}
                          onReset={() => removeOverride(row.id)}
                        />
                      ) : row.effectiveChord ? (
                        <Kbd size="sm">{formatKeyDisplay(row.effectiveChord)}</Kbd>
                      ) : (
                        <span className="text-xs italic text-text-muted">No key</span>
                      )}
                    </div>
                    <div role="cell" className="text-xs text-text-tertiary">
                      <span className="sm:hidden">Default: </span>
                      {row.defaultChord ? formatKeyDisplay(row.defaultChord) : '—'}
                    </div>
                    <div role="cell" className="text-xs text-text-tertiary">
                      <span className="sm:hidden">Scope: </span>{SCOPE_LABELS[row.scope]}
                    </div>
                    <div role="cell" className="flex flex-wrap gap-1 text-[11px] text-text-tertiary">
                      {STATE_LABELS[row.state] && <StateTag>{STATE_LABELS[row.state]}</StateTag>}
                      {row.availability === 'unavailable-platform' && <StateTag>Unavailable on this platform</StateTag>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {!query && (
            <div role="rowgroup" aria-label="Terminal and native shortcuts">
              <div aria-hidden="true" className="bg-surface-secondary/60 px-3 py-1 text-[11px] font-medium text-text-tertiary">
                Terminal / native — not remappable
              </div>
              {REFERENCE_ROWS.map((reference) => (
                <div key={reference.id} role="row" className="grid gap-1 border-t border-border-secondary px-3 py-2 text-text-secondary sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,2.3fr)] sm:items-center sm:gap-2">
                  <span role="cell">{reference.label}</span>
                  <span role="cell"><Kbd size="sm">{formatKeyDisplay(reference.chord)}</Kbd></span>
                  <span role="cell" className="text-xs text-text-tertiary">Owned by the terminal or the view</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={Object.keys(draft).length === 0}
          onClick={() => setConfirmResetAll(true)}
        >
          Reset all to defaults
        </Button>
        <div className="flex flex-col items-end gap-1">
          {conflicted && (
            <ul role="alert" className="text-xs text-status-error">
              {map.conflicts.map((conflict) => (
                <li key={conflict.chord}>
                  {formatKeyDisplay(conflict.chord)} is bound to {conflict.ids.map((id) => labelForId(id, sources)).join(' and ')}
                </li>
              ))}
              <li>Resolve conflicts to apply.</li>
            </ul>
          )}
          {applyBlockedReason && dirty && (
            <span className="text-xs text-text-tertiary">{applyBlockedReason}</span>
          )}
          <Button type="button" size="sm" disabled={!dirty || conflicted || Boolean(applyBlockedReason)} onClick={onApply}>Apply</Button>
        </div>
      </div>
      <ConfirmDialog
        isOpen={confirmResetAll}
        onClose={() => setConfirmResetAll(false)}
        onConfirm={() => { setConfirmResetAll(false); onDraftChange({}); }}
        title="Reset all key bindings?"
        message="Every command returns to its default shortcut. Apply afterwards to save."
        confirmText="Reset all"
        cancelText="Keep bindings"
        variant="warning"
      />
    </div>
  );
}

function StateTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border-secondary px-1 py-px text-[10px] uppercase tracking-wide text-text-tertiary">
      {children}
    </span>
  );
}
