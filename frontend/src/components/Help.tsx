import { useMemo } from 'react';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
import { Button } from './ui/Button';
import { useConfigStore } from '../stores/configStore';
import { rendererKeyPlatform } from '../stores/hotkeyStore';
import { formatKeyDisplay, CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/hotkeyUtils';
import { buildShortcutMap, REFERENCE_ROWS, type ShortcutMapRow } from '../utils/shortcutMap';
import { rendererPlatform } from '../utils/platformUtils';
import { Kbd } from './ui/Kbd';

/** Every command in the catalog with the key it answers to now, grouped as in Keyboard Shortcuts. */
function KeyboardShortcutsSection({ onOpenKeyboardShortcuts }: { onOpenKeyboardShortcuts?: () => void }) {
  const config = useConfigStore((state) => state.config);
  const map = useMemo(() => buildShortcutMap({
    overridesRaw: config?.keyboardShortcutOverrides,
    terminalShortcuts: config?.terminalShortcuts,
    customCommands: config?.customCommands,
    environment: rendererPlatform(),
    keyPlatform: rendererKeyPlatform(),
  }), [config?.keyboardShortcutOverrides, config?.terminalShortcuts, config?.customCommands]);

  const grouped = useMemo(() => {
    const byCategory = new Map<string, ShortcutMapRow[]>();
    for (const row of map.rows) {
      if (row.availability !== 'available') continue;
      const group = byCategory.get(row.category) ?? [];
      group.push(row);
      byCategory.set(row.category, group);
    }
    return CATEGORY_ORDER.flatMap((category) => {
      const rows = byCategory.get(category);
      return rows ? [{ category, rows }] : [];
    });
  }, [map.rows]);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-text-primary">Keyboard Shortcuts</h3>
        {onOpenKeyboardShortcuts && (
          <Button type="button" variant="secondary" size="sm" onClick={onOpenKeyboardShortcuts}>
            Change keys…
          </Button>
        )}
      </div>
      <div className="space-y-4">
        {grouped.map(({ category, rows }) => (
          <div key={category}>
            <h4 className="text-sm font-medium text-text-tertiary mb-2">{CATEGORY_LABELS[category]}</h4>
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} data-shortcut-id={row.id} className="flex justify-between items-center gap-3">
                  <span className="text-text-secondary">{row.label}</span>
                  {row.effectiveChord ? (
                    <Kbd size="md">{formatKeyDisplay(row.effectiveChord)}</Kbd>
                  ) : (
                    <span className="text-xs text-text-muted italic">palette only</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div>
          <h4 className="text-sm font-medium text-text-tertiary mb-2">In lists, the terminal and Approvals</h4>
          <div className="space-y-2">
            {REFERENCE_ROWS.map((row) => (
              <div key={row.id} className="flex justify-between items-center gap-3">
                <span className="text-text-secondary">{row.label}</span>
                <Kbd size="md">{formatKeyDisplay(row.chord)}</Kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

interface HelpProps {
  isOpen: boolean;
  onClose: () => void;
  shortcutsOnly?: boolean;
  /** Opens Settings › Shortcuts › Keyboard Shortcuts, where keys are changed. */
  onOpenKeyboardShortcuts?: () => void;
}

export default function Help({ isOpen, onClose, shortcutsOnly = false, onOpenKeyboardShortcuts }: HelpProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader title={shortcutsOnly ? 'Keyboard Shortcuts' : 'Pane Help'} />
      <ModalBody>
        {shortcutsOnly ? (
          <KeyboardShortcutsSection onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} />
        ) : (
          <div className="space-y-8">
            <section className="space-y-3 text-text-secondary">
              <h3 className="text-lg font-semibold text-text-primary">Working with Pane</h3>
              <p>Add a repository, then create a pane for your work. A pane groups terminal tabs and tools around a workspace; tabs in the same pane share its files.</p>
              <p>Choose your agent or shell when creating a terminal. Use Review to inspect changes, and run your project's checks in a terminal before committing.</p>
              <p>Archive panes when you finish. You can find them again in the repository's Archived list.</p>
              <a href="https://runpane.com/docs" target="_blank" rel="noopener noreferrer" className="text-interactive hover:underline">Read the Pane documentation</a>
            </section>
            <KeyboardShortcutsSection onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} />
          </div>
        )}
      </ModalBody>
      
      <div className="p-4 border-t border-border-primary text-center text-sm text-text-muted">
        Pane — terminal workspaces for your repositories
      </div>
    </Modal>
  );
}
