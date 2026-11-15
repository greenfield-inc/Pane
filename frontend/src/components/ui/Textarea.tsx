import React, { forwardRef, useId } from 'react';
import { cn } from '../../utils/cn';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string | null;
  label?: string;
  description?: string;
  helperText?: string;
  fullWidth?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({
    className,
    error,
    label,
    description,
    helperText,
    fullWidth = false,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...props
  }, ref) => {
    const generatedId = useId();
    const textareaId = id || `textarea-${generatedId}`;
    const visibleMessage = error || description || helperText;
    const messageId = visibleMessage ? `${textareaId}-${error ? 'error' : 'help'}` : undefined;
    const describedBy = [ariaDescribedBy, messageId].filter(Boolean).join(' ') || undefined;

    return (
      <div className={cn(fullWidth && 'w-full')}>
        {label && (
          <label 
            htmlFor={textareaId}
            className="block text-sm font-medium text-text-primary mb-2"
          >
            {label}
          </label>
        )}
        
        <textarea
          data-pane-part="input"
          id={textareaId}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid ?? !!error}
          className={cn(
            'w-full px-3 py-2 rounded-md border transition-colors',
            'text-text-primary placeholder-text-tertiary',
            'focus:outline-none focus:ring-2 focus:ring-interactive focus:border-interactive',
            error 
              ? 'border-status-error bg-surface-primary' 
              : 'border-border-primary bg-surface-primary hover:border-border-hover',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className
          )}
          ref={ref}
          {...props}
        />
        
        {error && (
          <p id={messageId} role="alert" className="mt-2 text-sm text-status-error">
            {error}
          </p>
        )}
        
        {description && !error && (
          <p id={messageId} className="mt-2 text-sm text-text-tertiary">
            {description}
          </p>
        )}
        
        {helperText && !error && !description && (
          <p id={messageId} className="mt-2 text-sm text-text-tertiary">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
