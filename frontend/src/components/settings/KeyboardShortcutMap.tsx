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

function whereToEdit(id: string): string {
  if (id.startsWith('terminal-shortcut-')) return ' (edit in Terminal snippets below)';
  if (id.startsWith('add-tool-custom-')) return ' (custom command; remap it in its own row or in Add Tool › Custom commands)';
  return '';
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
  const lowerQuery = query.trim().toLowerCase();
  const visibleReference = REFERENCE_ROWS.filter((reference) =>
    !lowerQuery || reference.label.toLowerCase().includes(lowerQuery) || reference.chord.toLowerCase().includes(lowerQuery));
  const conflicted = map.conflicts.length > 0;
  const sources = { terminalShortcuts, customCommands };

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
        <table aria-label="Key bindings" className="w-full min-w-[48rem] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-surface-primary">
            <tr className="border-b border-border-secondary text-[11px] uppercase tracking-wide text-text-tertiary">
              {['Command', 'Shortcut', 'Default', 'Scope', 'State'].map((heading) => (
                <th key={heading} scope="col" className="px-3 py-1.5 font-medium">{heading}</th>
              ))}
            </tr>
          </thead>
          {grouped.length === 0 && visibleReference.length === 0 && (
            <tbody><tr><td colSpan={5} className="px-3 py-2 text-xs text-text-tertiary">No shortcuts match “{query}”.</td></tr></tbody>
          )}
          {grouped.map(({ category, rows: groupRows }) => (
            <tbody key={category} aria-label={CATEGORY_LABELS[category]}>
              <tr><th colSpan={5} scope="colgroup" className="bg-surface-secondary/60 px-3 py-1 text-[11px] font-medium text-text-tertiary">
                {CATEGORY_LABELS[category]}
              </th></tr>
              {groupRows.map((row) => {
                const statusId = `shortcut-status-${row.id}`;
                const conflictText = row.conflicts.length > 0
                  ? `${row.effectiveChord ? formatKeyDisplay(row.effectiveChord) : 'This key'} is also bound to ${row.conflicts.map((id) => labelForId(id, sources) + whereToEdit(id)).join(', ')}`
                  : '';
                return (
                  <tr
                    key={row.id}
                    data-shortcut-id={row.id}
                    className="border-t border-border-secondary"
                  >
                    <td className="px-3 py-2 min-w-0 text-text-primary">
                      <span>{row.label}</span>
                      {row.origin === 'snippet' && (
                        <span className="ml-1 text-[11px] text-text-tertiary">Snippet — edit in Terminal snippets below</span>
                      )}
                      {conflictText && (
                        <p id={statusId} role="alert" className="mt-0.5 text-[11px] text-status-error">{conflictText}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-0">
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
                    </td>
                    <td className="px-3 py-2 text-xs text-text-tertiary">
                      {row.defaultChord ? formatKeyDisplay(row.defaultChord) : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-tertiary">
                      {SCOPE_LABELS[row.scope]}
                    </td>
                    <td className="px-3 py-2 space-x-1 text-[11px] text-text-tertiary">
                      {STATE_LABELS[row.state] && <StateTag>{STATE_LABELS[row.state]}</StateTag>}
                      {row.availability === 'unavailable-platform' && <StateTag>Unavailable on this platform</StateTag>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
          {visibleReference.length > 0 && (
            <tbody aria-label="Terminal and native shortcuts">
              <tr><th colSpan={5} scope="colgroup" className="bg-surface-secondary/60 px-3 py-1 text-[11px] font-medium text-text-tertiary">
                Terminal / native — not remappable
              </th></tr>
              {visibleReference.map((reference) => (
                <tr key={reference.id} className="border-t border-border-secondary text-text-secondary">
                  <td className="px-3 py-2">{reference.label}</td>
                  <td className="px-3 py-2"><Kbd size="sm">{formatKeyDisplay(reference.chord)}</Kbd></td>
                  <td colSpan={3} className="px-3 py-2 text-xs text-text-tertiary">Owned by the terminal or the view</td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
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
