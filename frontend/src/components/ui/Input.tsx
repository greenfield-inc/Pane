import React, { useId } from 'react';
import { cn } from '../../utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
  icon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ 
    className, 
    label,
    error,
    helperText,
    fullWidth = false,
    icon,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...props 
  }, ref) => {
    const generatedId = useId();
    const inputId = id || `input-${generatedId}`;
    const messageId = error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined;
    const describedBy = [ariaDescribedBy, messageId].filter(Boolean).join(' ') || undefined;
    
    const baseStyles = 'px-input-x py-input-y bg-bg-primary text-text-primary placeholder:text-text-muted border rounded-input transition-all duration-normal focus:outline-none focus:ring-1 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50';

    const stateStyles = error
      ? 'border-status-error focus:border-status-error focus:ring-status-error'
      : 'border-border-primary focus:border-border-focus focus:ring-interactive';
    
    const widthStyles = fullWidth ? 'w-full' : '';
    
    return (
      <div className={cn(fullWidth && 'w-full')}>
        {label && (
          <label 
            htmlFor={inputId} 
            className="block text-label font-medium text-text-primary mb-1"
          >
            {label}
          </label>
        )}
        <div className={cn('relative', fullWidth && 'w-full')}>
          {icon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              {icon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              baseStyles,
              stateStyles,
              widthStyles,
              icon && 'pl-10',
              className
            )}
            aria-invalid={ariaInvalid ?? !!error}
            aria-describedby={describedBy}
            {...props}
          />
        </div>
        {error && (
          <p id={`${inputId}-error`} className="mt-1 text-sm text-status-error">
            {error}
          </p>
        )}
        {helperText && !error && (
          <p id={`${inputId}-helper`} className="mt-1 text-sm text-text-muted">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

// Textarea component with similar API
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ 
    className, 
    label,
    error,
    helperText,
    fullWidth = false,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...props 
  }, ref) => {
    const generatedId = useId();
    const textareaId = id || `textarea-${generatedId}`;
    const messageId = error ? `${textareaId}-error` : helperText ? `${textareaId}-helper` : undefined;
    const describedBy = [ariaDescribedBy, messageId].filter(Boolean).join(' ') || undefined;
    
    const baseStyles = 'px-input-x py-input-y bg-bg-primary text-text-primary placeholder:text-text-muted border rounded-input transition-all duration-normal focus:outline-none focus:ring-1 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 resize-none';

    const stateStyles = error
      ? 'border-status-error focus:border-status-error focus:ring-status-error'
      : 'border-border-primary focus:border-border-focus focus:ring-interactive';
    
    const widthStyles = fullWidth ? 'w-full' : '';
    
    return (
      <div className={cn(fullWidth && 'w-full')}>
        {label && (
          <label 
            htmlFor={textareaId} 
            className="block text-label font-medium text-text-primary mb-1"
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={cn(
            baseStyles,
            stateStyles,
            widthStyles,
            className
          )}
          aria-invalid={ariaInvalid ?? !!error}
          aria-describedby={describedBy}
          {...props}
        />
        {error && (
          <p id={`${textareaId}-error`} className="mt-1 text-sm text-status-error">
            {error}
          </p>
        )}
        {helperText && !error && (
          <p id={`${textareaId}-helper`} className="mt-1 text-sm text-text-muted">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

// Checkbox component
export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ 
    className, 
    label,
    id,
    ...props 
  }, ref) => {
    const generatedId = useId();
    const checkboxId = id || `checkbox-${generatedId}`;
    
    return (
      <label htmlFor={checkboxId} className="flex items-center space-x-2 cursor-default">
        <input
          ref={ref}
          id={checkboxId}
          type="checkbox"
          className={cn(
            'rounded border-border-primary text-interactive focus:ring-1 focus:ring-offset-0 focus:ring-interactive transition-all duration-normal disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
          {...props}
        />
        <span className="text-text-primary select-none">{label}</span>
      </label>
    );
  }
);

Checkbox.displayName = 'Checkbox';
