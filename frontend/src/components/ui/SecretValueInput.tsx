import { forwardRef, type ClipboardEvent, type InputHTMLAttributes } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '../../utils/cn';

interface SecretValueInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
  /** `field` looks like `Input`; `bare` leaves the look to the caller. */
  appearance?: 'field' | 'bare';
  /** Enter runs this, or submits the enclosing form when there is none. */
  onEnter?: () => void;
}

/** What the field shows: a password input drops line breaks, so each becomes a space of the same length. */
const shown = (value: string) => value.replace(/[\r\n]/g, ' ');

/**
 * `previous` after the browser edited its shown text into `next`, with the caret at `caret`:
 * one contiguous change that ends at the caret. Line breaks outside it are kept.
 */
function applyEdit(previous: string, next: string, caret: number): string {
  const kept = next.length - caret;
  const before = shown(previous);
  const limit = Math.min(caret, previous.length - kept);
  let start = 0;
  while (start < limit && before[start] === next[start]) start++;
  return previous.slice(0, start) + next.slice(start, caret) + previous.slice(previous.length - kept);
}

/** Lines of the value, not counting a final line break. */
const lineCount = (value: string) => value.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length;

/**
 * A password field for a secret value that keeps the line breaks of a pasted value, so a
 * PEM key arrives intact. A real password input, so macOS turns on secure input and
 * accessibility tools get no value.
 */
export const SecretValueInput = forwardRef<HTMLInputElement, SecretValueInputProps>(
  ({ value, onValueChange, appearance = 'field', onEnter, onKeyDown, onPaste, className, ...props }, ref) => {
    const lines = lineCount(value);
    const paste = (event: ClipboardEvent<HTMLInputElement>) => {
      onPaste?.(event);
      const text = event.clipboardData.getData('text');
      if (event.defaultPrevented || !/[\r\n]/.test(text)) return;
      event.preventDefault();
      const field = event.currentTarget;
      const start = field.selectionStart ?? value.length;
      const end = field.selectionEnd ?? start;
      // Rendered now, so the caret lands after the pasted text before the next key.
      flushSync(() => onValueChange(value.slice(0, start) + text + value.slice(end)));
      field.setSelectionRange(start + text.length, start + text.length);
    };
    return (
      <span className="relative flex min-w-0 flex-1 items-center self-stretch">
        <input
          ref={ref}
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(
            'ph-no-capture w-full',
            appearance === 'field' && 'px-input-x py-input-y bg-bg-primary text-text-primary placeholder:text-text-muted border border-border-primary rounded-input transition-all duration-normal focus:outline-none focus:ring-1 focus:ring-offset-0 focus:border-border-focus focus:ring-interactive disabled:cursor-not-allowed disabled:opacity-50',
            className,
            lines > 1 && 'pr-20',
          )}
          value={shown(value)}
          onChange={(event) => {
            const field = event.currentTarget;
            onValueChange(applyEdit(value, field.value, field.selectionEnd ?? field.value.length));
          }}
          onPaste={paste}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented || event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (onEnter) onEnter();
            else event.currentTarget.form?.requestSubmit();
          }}
          {...props}
        />
        {lines > 1 && (
          <span className="pointer-events-none absolute right-3 text-xs text-text-muted">{lines} lines</span>
        )}
      </span>
    );
  },
);

SecretValueInput.displayName = 'SecretValueInput';
