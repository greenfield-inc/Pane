import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Pencil } from 'lucide-react';
import { MACHINE_COLOR_NAMES } from '../../../../shared/utils/machineColor';
import { normalizeMarkLetters, type MachineColorName, type MachineMarkOverride } from '../../../../shared/utils/machineMarks';
import { useConfigStore } from '../../stores/configStore';
import { showActionError } from '../../stores/errorStore';
import { machineColorVar } from './MachineMark';
import type { MachineEntry } from '../../utils/machineList';

const POPOVER_WIDTH = 268;
const GAP = 8;

/** Saves one machine's mark on this computer; an empty override goes back to automatic. */
async function saveMark(key: string, change: (current: MachineMarkOverride) => MachineMarkOverride): Promise<void> {
  const { config, updateConfig } = useConfigStore.getState();
  const marks = { ...config?.machineMarks };
  const next = change(marks[key] ?? {});
  if (next.letters || next.color) marks[key] = next;
  else delete marks[key];
  try {
    await updateConfig({ machineMarks: marks });
  } catch (cause) {
    showActionError('Could not save the machine mark', cause instanceof Error ? cause.message : 'The config file could not be written. Nothing changed; try again.');
  }
}

/**
 * The switcher's pencil for one machine: a small popover that sets its letters and colour,
 * saved on this computer only (D-252), or resets both to automatic.
 */
export function MachineMarkEditor({ machine }: { machine: Pick<MachineEntry, 'name' | 'letters' | 'slot' | 'markKey' | 'customMark'> }) {
  const [open, setOpen] = useState(false);
  const [letters, setLetters] = useState('');
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Beside the menu, at the pencil's height, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const menu = buttonRef.current.closest('[role="menu"]')?.getBoundingClientRect() ?? anchor;
    const right = menu.right + GAP;
    const left = right + POPOVER_WIDTH <= window.innerWidth - GAP ? right : Math.max(GAP, menu.left - GAP - POPOVER_WIDTH);
    setStyle({ position: 'fixed', top: Math.max(GAP, Math.min(anchor.top - 12, window.innerHeight - 220)), left, width: POPOVER_WIDTH });
  }, [open]);

  // Once placed (a hidden field can't take focus), the letter field takes focus.
  const placed = open && style.visibility !== 'hidden';
  useEffect(() => {
    if (!placed) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [placed]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setStyle({ visibility: 'hidden' });
    if (refocus) buttonRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // The menu closes on Tab and Escape; inside the popover they belong to it.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };

  const changeLetters = (value: string) => {
    const next = normalizeMarkLetters(value);
    setLetters(next);
    void saveMark(machine.markKey, (current) => ({ ...current, letters: next || undefined }));
  };

  const pickColor = (color: MachineColorName) => {
    void saveMark(machine.markKey, (current) => ({ ...current, color }));
  };

  const reset = () => {
    setLetters('');
    void saveMark(machine.markKey, () => ({}));
    inputRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Change the mark for ${machine.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="machine-mark-edit"
        onClick={(event) => {
          event.stopPropagation();
          setLetters(machine.customMark ? machine.letters : '');
          setOpen((value) => !value);
        }}
        className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <>
          {/* Clicks beside the popover close it without reaching the menu behind. */}
          <div className="fixed inset-0 z-[10001]" aria-hidden="true" onMouseDown={(event) => { event.stopPropagation(); close(false); }} />
          <div
            role="dialog"
            aria-label={`Mark for ${machine.name}`}
            data-testid="machine-mark-popover"
            onKeyDown={onKeyDown}
            onClick={(event) => event.stopPropagation()}
            style={style}
            className="z-[10002] rounded-lg border border-border-primary bg-surface-primary p-3 text-left shadow-dropdown"
          >
            <label htmlFor={`mark-letters-${machine.markKey}`} className="block text-[12px] font-semibold text-text-primary">Letter for {machine.name}</label>
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={inputRef}
                id={`mark-letters-${machine.markKey}`}
                value={letters}
                placeholder={machine.customMark ? undefined : machine.letters}
                onChange={(event) => changeLetters(event.target.value)}
                maxLength={4}
                spellCheck={false}
                autoComplete="off"
                className="h-7 w-11 rounded-md border border-border-primary bg-surface-secondary text-center font-mono text-[12px] font-semibold text-text-primary placeholder:text-text-tertiary focus:border-interactive focus:outline-none focus:ring-2 focus:ring-focus-ring-subtle"
              />
              <span className="text-[12px] text-text-tertiary">1–2 letters</span>
            </div>
            <p id={`mark-colour-${machine.markKey}`} className="mt-3 text-[12px] font-semibold text-text-primary">Colour</p>
            <div role="radiogroup" aria-labelledby={`mark-colour-${machine.markKey}`} className="mt-2 flex items-center gap-2">
              {MACHINE_COLOR_NAMES.map((color, slot) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={machine.slot === slot}
                  aria-label={color}
                  onClick={() => pickColor(color)}
                  className="h-5 w-5 rounded-full"
                  // The chosen colour keeps its ring after a click, which clears Tailwind rings on buttons; keyboard focus gets the theme outline.
                  style={{
                    backgroundColor: machineColorVar(slot),
                    boxShadow: machine.slot === slot ? `0 0 0 2px var(--color-surface-primary), 0 0 0 3.5px ${machineColorVar(slot)}` : undefined,
                  }}
                />
              ))}
            </div>
            <p className="mt-3 text-[12px] text-text-tertiary">Shown on this computer</p>
            <button
              type="button"
              onClick={reset}
              disabled={!machine.customMark}
              className="mt-2 rounded text-[12px] font-medium text-interactive hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle disabled:cursor-default disabled:text-text-tertiary disabled:no-underline"
            >
              Reset to automatic
            </button>
          </div>
        </>
      )}
    </>
  );
}
