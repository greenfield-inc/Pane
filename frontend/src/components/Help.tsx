import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
import { Button } from './ui/Button';
import { useConfigStore } from '../stores/configStore';
import { useHotkeyStore, rendererKeyPlatform } from '../stores/hotkeyStore';
import { useNotifyStore } from '../stores/notifyStore';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../shared/types/notify';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { buildShortcutMap, type SheetGroupId } from '../utils/shortcutMap';
import { buildShortcutSheet, searchShortcutSheet, SHEET_GROUPS, type SheetKey, type SheetRow } from '../utils/shortcutSheet';
import { isMac, rendererPlatform } from '../utils/platformUtils';
import { cn } from '../utils/cn';

/** The group the sheet shows when it opens: the one viewed last (renderer UI state, not saved). */
let lastViewedGroup: SheetGroupId = 'navigation';

function Cap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded-md border border-b-2 border-border-primary bg-surface-secondary px-1.5 py-0.5 font-mono text-[11px] leading-none text-text-primary">
      {children}
    </kbd>
  );
}

function Keys({ keys }: { keys: readonly SheetKey[] }) {
  if (keys.length === 0) return <span className="text-xs italic text-text-tertiary">palette only</span>;
  return (
    <span className="flex flex-none items-center gap-1">
      {keys.map((key, index) => key.kind === 'gap'
        ? <span key={`gap-${index}`} className="px-0.5 text-text-tertiary">…</span>
        : <Cap key={`${key.chord}-${index}`}>{key.text}</Cap>)}
    </span>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-[color-mix(in_srgb,var(--color-status-warning)_35%,transparent)] text-inherit">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function ChangedDot() {
  return <span aria-label="Changed by you" title="Changed by you" className="h-1.5 w-1.5 flex-none rounded-full bg-interactive" />;
}

function SheetRowView({ row, query, onOpenAnswerAllSetting }: { row: SheetRow; query: string; onOpenAnswerAllSetting?: () => void }) {
  return (
    <div data-shortcut-id={row.id} className="flex min-h-[28px] items-center justify-between gap-3 py-1 text-sm">
      <span className="flex min-w-0 items-center gap-1.5 text-text-secondary">
        <span><Highlighted text={row.label} query={query} /></span>
        {row.changed && <ChangedDot />}
        {row.link === 'answer-all' && onOpenAnswerAllSetting && (
          <button type="button" onClick={onOpenAnswerAllSetting} className="text-xs text-interactive hover:underline">
            Change in Settings › Approvals
          </button>
        )}
      </span>
      <Keys keys={row.keys} />
    </div>
  );
}

interface KeyboardShortcutSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens Settings › Shortcuts › Keyboard Shortcuts, where keys are changed. */
  onOpenKeyboardShortcuts?: () => void;
  /** Opens Settings › Approvals at the answer-all key. */
  onOpenAnswerAllSetting?: () => void;
}

/**
 * The keyboard shortcut sheet (⌘/): a group rail and a search box over every
 * key Pane answers to, with the person's own keys marked.
 */
export function KeyboardShortcutSheet({ isOpen, onClose, onOpenKeyboardShortcuts, onOpenAnswerAllSetting }: KeyboardShortcutSheetProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" showCloseButton={false} ariaLabel="Keyboard Shortcuts" className="h-[min(640px,calc(100vh-2rem))]">
      {isOpen && <SheetContent onClose={onClose} onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} onOpenAnswerAllSetting={onOpenAnswerAllSetting} />}
    </Modal>
  );
}

function SheetContent({ onClose, onOpenKeyboardShortcuts, onOpenAnswerAllSetting }: Omit<KeyboardShortcutSheetProps, 'isOpen'>) {
  const config = useConfigStore((state) => state.config);
  const liveAnswerAll = useNotifyStore((state) => state.snapshot?.settings.shortcut);
  const answerAll = liveAnswerAll ?? config?.notify?.shortcut ?? DEFAULT_NOTIFY_SETTINGS.shortcut;
  const sheetKey = useHotkeyStore((state) => state.hotkeys.get('show-keyboard-shortcuts')?.keys ?? '');
  const settingsKey = useHotkeyStore((state) => state.hotkeys.get('open-shortcut-settings')?.keys ?? '');
  const mac = isMac();
  const groups = useMemo(() => buildShortcutSheet({
    rows: buildShortcutMap({
      overridesRaw: config?.keyboardShortcutOverrides,
      terminalShortcuts: config?.terminalShortcuts,
      customCommands: config?.customCommands,
      environment: rendererPlatform(),
      keyPlatform: rendererKeyPlatform(),
    }).rows,
    answerAll,
    mac,
  }), [config?.keyboardShortcutOverrides, config?.terminalShortcuts, config?.customCommands, answerAll, mac]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SheetGroupId>(lastViewedGroup);
  const railRef = useRef<HTMLDivElement>(null);
  const search = useMemo(() => searchShortcutSheet(groups, query, mac), [groups, query, mac]);
  const searching = query.trim().length > 0;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const shown = searching ? search.groups : groups.filter(group => group.id === active);

  const choose = (id: SheetGroupId) => {
    lastViewedGroup = id;
    setActive(id);
  };

  const onRailKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = SHEET_GROUPS.findIndex(group => group.id === active);
    const next = SHEET_GROUPS[(index + (event.key === 'ArrowDown' ? 1 : SHEET_GROUPS.length - 1)) % SHEET_GROUPS.length];
    choose(next.id);
    railRef.current?.querySelector<HTMLElement>(`[data-group="${next.id}"]`)?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border-primary px-[18px] py-3.5">
        <h2 className="whitespace-nowrap text-base font-semibold text-text-primary">Keyboard Shortcuts</h2>
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-primary bg-surface-secondary px-2.5 text-text-tertiary focus-within:border-interactive">
          <Search className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <input
            autoFocus
            aria-label="Search shortcuts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search by name or key, e.g. “approval” or “${mac ? '⌘⇧' : 'ctrl+shift'}”`}
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-text-tertiary hover:text-text-secondary">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={railRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label="Shortcut groups"
          onKeyDown={onRailKeyDown}
          className="w-[200px] flex-none overflow-y-auto border-r border-border-primary px-2 py-2.5"
        >
          {SHEET_GROUPS.map((group) => {
            const count = searching ? search.counts.get(group.id) ?? 0 : groups.find(candidate => candidate.id === group.id)?.rows.length ?? 0;
            const selected = group.id === active;
            return (
              <button
                key={group.id}
                type="button"
                role="tab"
                data-group={group.id}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => choose(group.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                  selected ? 'bg-surface-hover font-semibold text-text-primary' : 'text-text-secondary hover:bg-surface-hover',
                  searching && count === 0 && 'opacity-40',
                )}
              >
                <span>{group.name}</span>
                <small className="text-[11px] font-normal text-text-tertiary">{count}</small>
              </button>
            );
          })}
        </div>
        <div role="tabpanel" aria-label={searching ? 'Search results' : SHEET_GROUPS.find(group => group.id === active)?.name} className="min-w-0 flex-1 overflow-y-auto px-5 py-3">
          {shown.length === 0 && <p className="py-6 text-text-tertiary">No shortcut matches.</p>}
          {shown.map((group) => (
            <section key={group.id} aria-label={group.name} className="mb-3.5">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">{group.name}</h3>
              {group.rows.map((row) => <SheetRowView key={row.id} row={row} query={searching ? query.trim() : ''} onOpenAnswerAllSetting={onOpenAnswerAllSetting} />)}
            </section>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border-primary px-[18px] py-2.5 text-xs text-text-tertiary">
        <span className="inline-flex items-center gap-1.5"><ChangedDot /> changed by you</span>
        {onOpenKeyboardShortcuts && (
          <button type="button" onClick={onOpenKeyboardShortcuts} className="inline-flex items-center gap-1.5 text-[13px] text-interactive hover:underline">
            Change keys…
            {settingsKey && settingsKey.split(' ').map((step) => <Cap key={step}>{formatKeyDisplay(step, mac)}</Cap>)}
          </button>
        )}
        <span className="inline-flex items-center gap-1.5">
          {total} shortcuts · <Cap>{mac ? 'esc' : 'Esc'}</Cap>
          {sheetKey && <>or <Cap>{formatKeyDisplay(sheetKey, mac)}</Cap></>} to close
        </span>
      </div>
    </div>
  );
}

interface HelpProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the keyboard shortcut sheet. */
  onShowKeyboardShortcuts?: () => void;
}

export default function Help({ isOpen, onClose, onShowKeyboardShortcuts }: HelpProps) {
  const sheetKey = useHotkeyStore((state) => state.hotkeys.get('show-keyboard-shortcuts')?.keys ?? '');
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader title="Pane Help" />
      <ModalBody>
        <section className="space-y-3 text-text-secondary">
          <h3 className="text-lg font-semibold text-text-primary">Working with Pane</h3>
          <p>Add a repository, then create a pane for your work. A pane groups terminal tabs and tools around a workspace; tabs in the same pane share its files.</p>
          <p>Choose your agent or shell when creating a terminal. Use Review to inspect changes, and run your project's checks in a terminal before committing.</p>
          <p>Archive panes when you finish. You can find them again in the repository's Archived list.</p>
          <a href="https://runpane.com/docs" target="_blank" rel="noopener noreferrer" className="text-interactive hover:underline">Read the Pane documentation</a>
        </section>
        {onShowKeyboardShortcuts && (
          <div className="mt-6">
            <Button type="button" variant="secondary" size="sm" onClick={onShowKeyboardShortcuts}>
              Keyboard Shortcuts{sheetKey ? ` (${formatKeyDisplay(sheetKey)})` : ''}
            </Button>
          </div>
        )}
      </ModalBody>
      <div className="p-4 border-t border-border-primary text-center text-sm text-text-muted">
        Pane — terminal workspaces for your repositories
      </div>
    </Modal>
  );
}
