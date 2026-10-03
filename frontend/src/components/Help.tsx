import { useMemo } from 'react';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
import type { ShortcutCategory } from '../../../shared/constants/keyboardShortcuts';
import { useConfigStore } from '../stores/configStore';
import { CATEGORY_LABELS, CATEGORY_ORDER, formatKeyDisplay } from '../utils/hotkeyUtils';
import { rendererPlatform } from '../utils/platformUtils';
import { selectProfileOverridesRaw } from '../../../shared/utils/keyboardBindings';
import { normalizeShortcutProfileId } from '../../../shared/constants/keyboardShortcutProfiles';
import { buildShortcutMap, REFERENCE_ROWS, type ShortcutMapRow } from '../utils/shortcutMap';
import { Kbd } from './ui/Kbd';

function KeyboardShortcutsSection() {
  const config = useConfigStore((s) => s.config);
  const profile = normalizeShortcutProfileId(config?.keyboardShortcutProfile);
  const { rows } = useMemo(() => buildShortcutMap({
    overridesRaw: selectProfileOverridesRaw(config ?? undefined, profile),
    terminalShortcuts: config?.terminalShortcuts,
    customCommands: config?.customCommands,
    environment: rendererPlatform(),
    profile,
  }), [config, profile]);

  const grouped = useMemo(() => {
    const byCategory = new Map<ShortcutCategory, ShortcutMapRow[]>();
    for (const row of rows) {
      const group = byCategory.get(row.category) ?? [];
      group.push(row);
      byCategory.set(row.category, group);
    }
    return CATEGORY_ORDER.flatMap((category) => {
      const group = byCategory.get(category);
      return group ? [{ category, rows: group }] : [];
    });
  }, [rows]);

  return (
    <section>
      <h3 className="text-lg font-semibold text-text-primary mb-3">
        Keyboard Shortcuts
      </h3>
      <div className="space-y-4">
        {grouped.map(({ category, rows: groupRows }) => (
          <div key={category}>
            <h4 className="text-sm font-medium text-text-tertiary mb-2">
              {CATEGORY_LABELS[category]}
            </h4>
            <div className="space-y-2">
              {groupRows.map((row) => (
                <div key={row.id} className="flex justify-between items-center gap-3">
                  <span className="text-text-secondary">
                    {row.label}
                    {row.availability === 'unavailable-platform' && (
                      <span className="ml-2 text-xs text-text-muted">unavailable on this platform</span>
                    )}
                  </span>
                  {row.effectiveChord ? (
                    <Kbd size="md">{formatKeyDisplay(row.effectiveChord)}</Kbd>
                  ) : (
                    <span className="text-xs text-text-muted italic">unassigned</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div>
          <h4 className="text-sm font-medium text-text-tertiary mb-2">Terminal / native — not remappable</h4>
          <div className="space-y-2">
            {REFERENCE_ROWS.map((reference) => (
              <div key={reference.id} className="flex justify-between items-center">
                <span className="text-text-secondary">{reference.label}</span>
                <Kbd size="md">{formatKeyDisplay(reference.chord)}</Kbd>
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
}

export default function Help({ isOpen, onClose, shortcutsOnly = false }: HelpProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" showCloseButton={false}>
      <ModalHeader title={shortcutsOnly ? 'Keyboard Shortcuts' : 'Pane Help'} />
      <ModalBody>
        {shortcutsOnly ? (
          <KeyboardShortcutsSection />
        ) : (
          <div className="space-y-8">
            <section className="space-y-3 text-text-secondary">
              <h3 className="text-lg font-semibold text-text-primary">Working with Pane</h3>
              <p>Add a repository, then create a pane for your work. A pane groups terminal tabs and tools around a workspace; tabs in the same pane share its files.</p>
              <p>Choose your agent or shell when creating a terminal. Use Review to inspect changes, and run your project's checks in a terminal before committing.</p>
              <p>Archive panes when you finish. You can find them again in the repository's Archived list.</p>
              <a href="https://runpane.com/docs" target="_blank" rel="noopener noreferrer" className="text-interactive hover:underline">Read the Pane documentation</a>
            </section>
            <KeyboardShortcutsSection />
          </div>
        )}
      </ModalBody>
      
      <div className="p-4 border-t border-border-primary text-center text-sm text-text-muted">
        Pane — terminal workspaces for your repositories
      </div>
    </Modal>
  );
}
