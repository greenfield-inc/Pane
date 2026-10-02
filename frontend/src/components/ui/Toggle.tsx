import React from 'react';
import { cn } from '../../utils/cn';

interface ToggleProps {
  checked?: boolean;
  pressed?: boolean;
  onChange?: (checked: boolean) => void;
  onPressedChange?: (pressed: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  id?: string;
  variant?: 'default' | 'warning';
  title?: string;
  'aria-label'?: string;
  children?: React.ReactNode;
}

const sizeClasses = {
  sm: {
    container: 'h-5 w-9',
    thumb: 'h-3 w-3',
    translateOn: 'translate-x-5',
    translateOff: 'translate-x-1'
  },
  md: {
    container: 'h-6 w-11',
    thumb: 'h-4 w-4',
    translateOn: 'translate-x-6',
    translateOff: 'translate-x-1'
  },
  lg: {
    container: 'h-7 w-14',
    thumb: 'h-5 w-5',
    translateOn: 'translate-x-8',
    translateOff: 'translate-x-1'
  }
};

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  pressed,
  onChange,
  onPressedChange,
  disabled = false,
  size = 'md',
  className,
  id,
  variant = 'default',
  title,
  'aria-label': ariaLabel,
  children
}) => {
  const sizes = sizeClasses[size];
  const isPressed = pressed ?? checked ?? false;
  const handleChange = (newValue: boolean) => {
    if (onPressedChange) {
      onPressedChange(newValue);
    } else if (onChange) {
      onChange(newValue);
    }
  };

  // If children are provided, render as button toggle instead of switch
  if (children) {
    return (
      <button
        id={id}
        type="button"
        title={title}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && handleChange(!isPressed)}
        className={cn(
          'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
          'focus:outline-none focus:ring-2 focus:ring-interactive focus:ring-offset-2',
          isPressed 
            ? variant === 'warning' 
              ? 'bg-status-warning/20 text-status-warning border border-status-warning/30'
              : 'bg-interactive/20 text-interactive border border-interactive/30'
            : 'bg-surface-secondary text-text-secondary border border-border-primary hover:bg-surface-hover',
          disabled && 'opacity-50 cursor-not-allowed',
          !disabled && 'cursor-default',
          className
        )}
      >
        {children}
      </button>
    );
  }

  // Default switch toggle
  return (
    <button
      id={id}
      type="button"
      role="switch"
      title={title}
      aria-label={ariaLabel}
      aria-checked={isPressed}
      onClick={() => !disabled && handleChange(!isPressed)}
      disabled={disabled}
      className={cn(
        'relative inline-flex items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-interactive focus:ring-offset-2',
        sizes.container,
        isPressed ? 'bg-interactive' : 'bg-surface-secondary border border-border-primary',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && 'cursor-default',
        className
      )}
    >
      <span
        className={cn(
          'inline-block transform rounded-full bg-surface-primary border border-border-secondary shadow-sm transition-transform',
          sizes.thumb,
          checked ? sizes.translateOn : sizes.translateOff
        )}
      />
    </button>
  );
};
