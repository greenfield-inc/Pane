import { useMemo } from 'react';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
import { useHotkeyStore, type HotkeyDefinition } from '../stores/hotkeyStore';
import { formatKeyDisplay, CATEGORY_LABELS } from '../utils/hotkeyUtils';
import { Kbd } from './ui/Kbd';

function KeyboardShortcutsSection() {
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const allHotkeys = useMemo(
    () =>
      Array.from(hotkeys.values())
        .filter((def) => !def.devOnly || process.env.NODE_ENV === 'development')
        .filter((def) => def.showInPalette !== false)
        .filter((h) => !h.enabled || h.enabled()),
    [hotkeys]
  );

  const grouped = allHotkeys.reduce<Record<string, HotkeyDefinition[]>>((acc, def) => {
    if (!acc[def.category]) acc[def.category] = [];
    acc[def.category].push(def);
    return acc;
  }, {});

  return (
    <section>
      <h3 className="text-lg font-semibold text-text-primary mb-3">
        Keyboard Shortcuts
      </h3>
      <div className="space-y-4">
        {Object.entries(grouped).map(([category, hotkeys]) => {
          // SAFETY: grouped is keyed by HotkeyDefinition category values.
          const hotkeyCategory = category as HotkeyDefinition['category'];
          return <div key={category}>
            <h4 className="text-sm font-medium text-text-tertiary mb-2">
              {CATEGORY_LABELS[hotkeyCategory] ?? category}
            </h4>
            <div className="space-y-2">
              {hotkeys.map((hotkey) => (
                <div key={hotkey.id} className="flex justify-between items-center">
                  <span className="text-text-secondary">{hotkey.label}</span>
                  {hotkey.keys ? (
                    <Kbd size="md">
                      {formatKeyDisplay(hotkey.keys)}
                    </Kbd>
                  ) : (
                    <span className="text-xs text-text-muted italic">palette only</span>
                  )}
                </div>
              ))}
            </div>
          </div>;
        })}
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
