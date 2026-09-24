import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { Search } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';
import { useHotkeyStore, type HotkeyDefinition } from '../stores/hotkeyStore';
import { formatKeyDisplay, CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/hotkeyUtils';
import { Kbd } from './ui/Kbd';
import { Tooltip } from './ui/Tooltip';
import { cn } from '../utils/cn';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

type ListItem =
  // A category renders one header per availability pass, so the pass belongs
  // to the header's identity — otherwise the two passes produce duplicate
  // React keys and the list DOM corrupts while typing.
  | { type: 'header'; category: string; disabled: boolean }
  | { type: 'command'; hotkey: HotkeyDefinition; flatIndex: number; disabled: boolean; disabledReason: string | null };

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const getAll = useHotkeyStore((s) => s.getAll);
  const search = useHotkeyStore((s) => s.search);

  // Get filtered results — exclude the command palette's own hotkey and showInPalette: false.
  // Disabled commands remain visible, sorted after enabled commands.
  const results = (searchTerm
    ? search(searchTerm, { paletteOnly: true })
    : getAll({ paletteOnly: true })
  ).filter((h) => h.id !== 'open-command-palette');

  const { listItems, commandCount } = buildListItems(results);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setSearchTerm('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchTerm]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedEl = listRef.current?.querySelector('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const executeSelected = useCallback(() => {
    const commandItems = listItems.filter(
      (item): item is Extract<ListItem, { type: 'command' }> => item.type === 'command'
    );
    const selected = commandItems[selectedIndex];
    if (selected) {
      if (selected.disabled) return;
      onClose();
      setTimeout(() => selected.hotkey.action(), 50);
    }
  }, [listItems, selectedIndex, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        if (commandCount === 0) break;
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % commandCount);
        break;
      case 'ArrowUp':
        if (commandCount === 0) break;
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + commandCount) % commandCount);
        break;
      case 'Enter':
        e.preventDefault();
        executeSelected();
        break;
    }
  };

  return (
    <Modal
      ariaLabel="Command Palette"
      isOpen={isOpen}
      onClose={onClose}
      initialFocusRef={inputRef}
      size="md"
      // Cmd+Shift+P is a hundred-times-a-day reflex. Anything between the
      // keystroke and a focused input reads as the app being slow, not as
      // polish, so the palette does not animate in.
      instant
      showCloseButton={false}
      className="!max-h-[min(500px,80vh)]"
    >
      {/* Search input */}
      <div className="p-3 border-b border-border-primary">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="w-4 h-4 text-text-muted" />
          </div>
          <Input
            ref={inputRef}
            aria-label="Search commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={commandCount > 0}
            aria-controls={listboxId}
            aria-activedescendant={commandCount > 0 ? `${listboxId}-option-${selectedIndex}` : undefined}
            type="text"
            placeholder="Search commands..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-10 border-none focus:ring-0 bg-transparent"
          />
        </div>
      </div>

      {/* Results list */}
      <div
        id={listboxId}
        ref={listRef}
        role="listbox"
        aria-label="Commands"
        className="overflow-y-auto py-2"
        style={{ maxHeight: '380px' }}
      >
        {commandCount === 0 ? (
          <div className="px-4 py-8 text-center text-text-tertiary text-sm">
            No commands found
          </div>
        ) : (
          listItems.map((item) => {
            if (item.type === 'header') {
              // SAFETY: Header categories are produced from the typed hotkey registry keys.
              const category = item.category as HotkeyDefinition['category'];
              return (
                <div
                  key={`header-${item.category}-${item.disabled ? 'unavailable' : 'available'}`}
                  className="px-4 pt-3 pb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider"
                >
                  {CATEGORY_LABELS[category] ?? item.category}
                </div>
              );
            }
            const isSelected = item.flatIndex === selectedIndex;
            const button = (
              <button
                key={item.hotkey.id}
                id={`${listboxId}-option-${item.flatIndex}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected}
                aria-disabled={item.disabled}
                tabIndex={-1}
                className={cn(
                  // No transition on the row highlight either: it moves on every
                  // arrow key, and a 150ms cross-fade means the selection is
                  // always trailing the key you already pressed.
                  'w-full flex items-center justify-between px-4 py-2 text-sm',
                  item.disabled
                    ? 'text-text-tertiary opacity-60 cursor-not-allowed'
                    : 'cursor-pointer',
                  isSelected && !item.disabled && 'bg-interactive/15 text-text-primary',
                  isSelected && item.disabled && 'bg-surface-hover/60',
                  !isSelected && !item.disabled && 'text-text-secondary hover:bg-surface-hover'
                )}
                onClick={() => {
                  setSelectedIndex(item.flatIndex);
                  if (item.disabled) return;
                  onClose();
                  setTimeout(() => item.hotkey.action(), 50);
                }}
                onMouseEnter={() => setSelectedIndex(item.flatIndex)}
              >
                <span>{item.hotkey.label}</span>
                {item.hotkey.keys && (
                  <Kbd variant="muted" className="ml-4 shrink-0">
                    {formatKeyDisplay(item.hotkey.keys)}
                  </Kbd>
                )}
              </button>
            );

            if (item.disabled && item.disabledReason) {
              return (
                <Tooltip key={item.hotkey.id} content={item.disabledReason} side="right" className="block">
                  {button}
                </Tooltip>
              );
            }

            return (
              button
            );
          })
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-border-primary flex items-center gap-4 text-xs text-text-muted">
        <span><Kbd size="xs">↑↓</Kbd> navigate</span>
        <span><Kbd size="xs">↵</Kbd> execute</span>
        <span><Kbd size="xs">esc</Kbd> close</span>
      </div>
    </Modal>
  );
}

function buildListItems(results: HotkeyDefinition[]) {
  const grouped: Record<string, Array<{ hotkey: HotkeyDefinition; disabled: boolean; disabledReason: string | null }>> = {};
  for (const def of results) {
    if (!grouped[def.category]) grouped[def.category] = [];
    const disabled = !!def.enabled && !def.enabled();
    grouped[def.category].push({
      hotkey: def,
      disabled,
      disabledReason: disabled ? def.disabledReason?.() ?? 'Command unavailable' : null,
    });
  }

  const listItems: ListItem[] = [];
  let flatIndex = 0;
  const appendCategoryItems = (category: HotkeyDefinition['category'], disabled: boolean) => {
    const hotkeys = grouped[category];
    const filteredHotkeys = hotkeys?.filter((item) => item.disabled === disabled);
    if (!filteredHotkeys?.length) return;
    listItems.push({ type: 'header', category, disabled });
    for (const item of filteredHotkeys) {
      listItems.push({ type: 'command', ...item, flatIndex });
      flatIndex++;
    }
  };

  for (const category of CATEGORY_ORDER) {
    appendCategoryItems(category, false);
  }
  for (const category of CATEGORY_ORDER) {
    appendCategoryItems(category, true);
  }

  return { listItems, commandCount: flatIndex };
}
