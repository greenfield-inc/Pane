import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../utils/cn';

interface SecretFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'wrap'> {
  /** `field` looks like `Input`; `bare` leaves the look to the caller. */
  appearance?: 'field' | 'bare';
  /** Enter runs this, or submits the enclosing form when there is none. */
  onEnter?: () => void;
}

/**
 * A masked one-line field for a secret value that keeps line breaks, so a pasted
 * PEM key arrives intact. Enter submits and Shift+Enter adds a line break.
 * A password input would strip CR and LF from the value.
 */
export const SecretField = forwardRef<HTMLTextAreaElement, SecretFieldProps>(
  ({ appearance = 'field', onEnter, onKeyDown, className, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={1}
      wrap="off"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-secret-field=""
      className={cn(
        'block resize-none overflow-hidden whitespace-pre [-webkit-text-security:disc] placeholder:[-webkit-text-security:none]',
        appearance === 'field' && 'px-input-x py-0 bg-bg-primary text-text-primary placeholder:text-text-muted border border-border-primary rounded-input transition-all duration-normal focus:outline-none focus:ring-1 focus:ring-offset-0 focus:border-border-focus focus:ring-interactive disabled:cursor-not-allowed disabled:opacity-50',
        className,
        // Line height carries the vertical padding, so no other line shows above or below. Last, so a text size can't reset it.
        appearance === 'field' && 'leading-[calc(1.25rem+2*var(--input-padding-y))]',
      )}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (onEnter) onEnter();
        else event.currentTarget.form?.requestSubmit();
      }}
      {...props}
    />
  ),
);

SecretField.displayName = 'SecretField';
