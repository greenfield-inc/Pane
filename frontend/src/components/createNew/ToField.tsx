import { forwardRef, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../utils/cn';
import { filterSessionChoices, type SessionChoice } from '../../utils/sessionChoices';
import { ProfileAvatar } from '../profiles/ProfileAvatar';

const GROUP_LABELS = { agents: 'Agents', profiles: 'Profiles', other: 'Other agents' } satisfies Record<SessionChoice['group'], string>;

interface ToFieldProps {
  choices: readonly SessionChoice[];
  value: SessionChoice | undefined;
  onPick: (choice: SessionChoice) => void;
  /** Focus goes on after a pick (to the Session name). */
  onPicked: () => void;
  /** Profiles are being read, or why there are none; shown under their heading. */
  profilesStatus?: string | null;
  disabled?: boolean;
  /** The list opened or closed: the dialog keeps Esc for it while it's open. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Create New's To (T-63): one type-ahead, not chips, since a Session talks to one agent. It shows
 * the chosen agent or profile; typing filters the list, ↑↓ move, Return picks and focus moves on,
 * and Esc or leaving the field puts the choice back.
 */
export const ToField = forwardRef<HTMLInputElement, ToFieldProps>(function ToField({ choices, value, onPick, onPicked, profilesStatus, disabled, onOpenChange }, ref) {
  const listboxId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const shown = useMemo(() => filterSessionChoices(choices, query), [choices, query]);
  const active = shown.find(choice => choice.key === activeKey) ?? (query ? shown[0] : shown.find(choice => choice.key === value?.key) ?? shown[0]);
  const optionId = (choice: SessionChoice) => `${listboxId}-${choice.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  useEffect(() => {
    if (!open || !active) return;
    listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' });
  });

  const close = () => { setOpen(false); setQuery(''); setActiveKey(null); };
  const pick = (choice: SessionChoice | undefined) => {
    if (!choice || choice.disabledReason) return;
    onPick(choice);
    close();
    onPicked();
  };
  const move = (step: number) => {
    if (!open) { setOpen(true); return; }
    if (!active || shown.length === 0) return;
    setActiveKey(shown[(shown.indexOf(active) + step + shown.length) % shown.length].key);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open) pick(active);
      else onPicked();
    } else if (event.key === 'Escape' && open) {
      // Esc closes the list first; the dialog closes on the next one.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Backspace' && !query && !open) {
      setOpen(true);
    }
  };

  const rows: React.ReactNode[] = [];
  let lastGroup: SessionChoice['group'] | null = null;
  const heading = (group: SessionChoice['group']) => (
    <div key={`h-${group}`} role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">{GROUP_LABELS[group]}</div>
  );
  const statusRow = profilesStatus && <div key="profiles-status" role="presentation" className="px-3 py-1.5 text-[12px] text-text-tertiary">{profilesStatus}</div>;
  for (const choice of shown) {
    if (choice.group !== lastGroup) {
      if (!query && lastGroup === 'agents' && choice.group !== 'profiles' && statusRow) rows.push(heading('profiles'), statusRow);
      rows.push(heading(choice.group));
      lastGroup = choice.group;
    }
    const selected = choice === active;
    rows.push(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The combobox input owns the keys (↑↓, Return).
      <div
        key={choice.key}
        id={optionId(choice)}
        role="option"
        aria-selected={selected}
        aria-disabled={choice.disabledReason ? true : undefined}
        data-testid={`to-choice-${choice.key}`}
        onMouseMove={() => { if (!selected) setActiveKey(choice.key); }}
        onMouseDown={event => { event.preventDefault(); pick(choice); }}
        className={cn(
          'mx-1 flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5',
          selected && 'bg-surface-hover',
          choice.disabledReason && 'opacity-60',
        )}
      >
        <ProfileAvatar profileRef={choice.profileRef} agent={choice.agent} size={22} />
        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <span className="truncate text-[13px] text-text-primary">{choice.label}</span>
          <span className="truncate text-[11.5px] text-text-tertiary">{choice.disabledReason ?? choice.detail}</span>
        </span>
        {choice.key === value?.key && <Check className="h-3.5 w-3.5 flex-none text-text-tertiary" aria-hidden="true" />}
      </div>,
    );
  }
  if (!query && lastGroup === 'agents' && statusRow) rows.push(heading('profiles'), statusRow);

  return (
    <div className="relative min-w-0 flex-1">
      <div className={cn(
        'flex h-9 items-center gap-2 rounded-md border border-border-primary bg-bg-primary px-2.5 transition-colors',
        'focus-within:border-interactive focus-within:ring-2 focus-within:ring-interactive',
        disabled && 'opacity-60',
      )}>
        {!query && value && <ProfileAvatar profileRef={value.profileRef} agent={value.agent} size={20} />}
        <input
          ref={ref}
          type="text"
          role="combobox"
          aria-label="To"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && active ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          // Not typing, the field reads as the chosen agent or profile; typing replaces it.
          value={query || (open ? '' : value?.label ?? '')}
          placeholder={value?.label ?? 'Pick an agent or profile'}
          onChange={event => { setQuery(event.target.value); setActiveKey(null); setOpen(true); }}
          onFocus={event => event.currentTarget.select()}
          onBlur={close}
          onClick={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-text-primary placeholder:text-text-muted focus:outline-none"
        />
      </div>
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Agents and profiles"
        hidden={!open}
        className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border-primary bg-surface-primary py-1 shadow-lg"
      >
        {rows}
        {shown.length === 0 && <div className="px-3 py-3 text-center text-[13px] text-text-tertiary">No agent or profile matches “{query}”</div>}
      </div>
    </div>
  );
});
