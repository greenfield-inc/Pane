import { useEffect, useState, type ReactNode } from 'react';
import { Toggle } from '../ui/Toggle';
import { cn } from '../../utils/cn';

interface ImmediateToggleProps {
  value: boolean;
  onSave: (value: boolean) => Promise<boolean>;
  label: string;
  disabled?: boolean;
}

export function ImmediateToggle({ value, onSave, label, disabled }: ImmediateToggleProps) {
  const [localValue, setLocalValue] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setLocalValue(value), [value]);

  return (
    <Toggle
      checked={localValue}
      aria-label={label}
      disabled={disabled || saving}
      onChange={(nextValue) => {
        const previous = localValue;
        setLocalValue(nextValue);
        setSaving(true);
        void onSave(nextValue)
          .then((saved) => {
            if (!saved) setLocalValue(previous);
          })
          .finally(() => setSaving(false));
      }}
    />
  );
}

interface ImmediateCheckboxProps {
  value: boolean;
  onSave: (value: boolean) => Promise<boolean>;
  label: string;
  description?: string;
  disabled?: boolean;
}

/**
 * A labelled checkbox that saves on change. It shows the new value while the
 * save runs, then the saved config's value, so a failed save shows the old one.
 */
export function ImmediateCheckbox({ value, onSave, label, description, disabled }: ImmediateCheckboxProps) {
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  return (
    <label className={cn('flex items-start gap-2.5', disabled ? 'cursor-not-allowed' : 'cursor-default')}>
      <input
        type="checkbox"
        checked={pendingValue ?? value}
        disabled={disabled || pendingValue !== null}
        onChange={async (event) => {
          setPendingValue(event.target.checked);
          try {
            await onSave(event.target.checked);
          } finally {
            setPendingValue(null);
          }
        }}
        className="mt-0.5 rounded border-border-primary text-interactive focus:ring-interactive"
      />
      <span className="min-w-0">
        <span className="block text-sm text-text-primary">{label}</span>
        {description && <span className="block text-xs leading-relaxed text-text-tertiary">{description}</span>}
      </span>
    </label>
  );
}

interface SegmentedOption<T extends string | number> {
  id: T;
  label: ReactNode;
  description?: string;
}

interface SegmentedControlProps<T extends string | number> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  columns?: 2 | 3 | 4;
  disabled?: boolean;
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  label,
  columns = 2,
  disabled,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'grid min-w-[220px] gap-1 rounded-md bg-surface-secondary p-1',
        columns === 2 && 'grid-cols-2',
        columns === 3 && 'grid-cols-3',
        columns === 4 && 'grid-cols-4',
      )}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={disabled}
          title={option.description}
          onClick={() => onChange(option.id)}
          className={cn(
            'min-h-8 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
            value === option.id
              ? 'bg-surface-primary text-text-primary shadow-sm'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
