/**
 * Terminal-specific popover for xterm.js link actions.
 *
 * This is a specialized version of ui/Dropdown.tsx for terminal overlays.
 * We cannot use the standard Dropdown because:
 * 1. xterm.js provides raw MouseEvent coordinates, not React elements to anchor to
 * 2. Terminal links are registered via ILinkProvider API, not as React components
 * 3. Position must be calculated from absolute viewport coordinates
 *
 * For standard UI dropdowns anchored to React elements, use ui/Dropdown.tsx instead.
 */
import React, { useRef, useEffect, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';

export interface TerminalPopoverProps {
  visible: boolean;
  x: number;
  y: number;
  /** Where its bottom edge goes when it flips up near the window's bottom; defaults to `y`. */
  flipY?: number;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  /** A submenu of another popover: a click in it doesn't close that popover. */
  submenu?: boolean;
}

export const TerminalPopover: React.FC<TerminalPopoverProps> = ({
  visible,
  x,
  y,
  flipY = y,
  onClose,
  children,
  className,
  onMouseEnter,
  onMouseLeave,
  submenu = false,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Smart positioning to keep popover on screen
  useLayoutEffect(() => {
    if (!visible || !ref.current) return;

    const rect = ref.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let top = y;
    let left = x;

    // Flip up if near bottom
    if (top + rect.height > viewportHeight - 10) {
      top = flipY - rect.height;
    }

    // Keep on screen horizontally
    if (left + rect.width > viewportWidth - 10) {
      left = viewportWidth - rect.width - 10;
    }

    // Don't go off left edge
    if (left < 10) {
      left = 10;
    }

    // Don't go off top edge
    if (top < 10) {
      top = 10;
    }

    setPosition({ top, left });
  }, [visible, x, y, flipY]);

  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // A submenu's own popover is part of this one.
        if (!submenu && e.target instanceof Element && e.target.closest('[data-terminal-popover-submenu]')) return;
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Add listeners after a tick to avoid immediate close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [visible, onClose, submenu]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={ref}
      data-terminal-popover
      data-terminal-popover-submenu={submenu || undefined}
      className={cn('fixed z-[10001] w-56 max-w-[calc(100vw-20px)] max-h-[calc(100vh-20px)] overflow-y-auto bg-surface-primary border border-border-primary rounded-lg shadow-dropdown-elevated p-1', className)}
      style={{ left: position.left, top: position.top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body
  );
};

TerminalPopover.displayName = 'TerminalPopover';

// PopoverButton component for consistent styling
export interface PopoverButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger';
  children: React.ReactNode;
  /** React 19 passes it through to the button. */
  ref?: React.Ref<HTMLButtonElement>;
}

const popoverButtonVariants = {
  default: 'text-text-primary enabled:hover:bg-bg-hover',
  primary: 'text-interactive enabled:hover:bg-surface-interactive-hover',
  // Red text on the same neutral hover plate the other items use. A red
  // background token here has no alpha channel (Tailwind emits the bare
  // `var(--color-status-error)`), so tinting it silently paints a solid red
  // block over the red label — the menu item then reads as an unlabeled slab.
  danger: 'text-status-error enabled:hover:bg-bg-hover',
};

export const PopoverButton: React.FC<PopoverButtonProps> = ({
  variant = 'default',
  className,
  children,
  onMouseMove,
  ...props
}) => {
  return (
    <button
      className={cn(
        'w-full whitespace-nowrap rounded px-3 py-2 text-left text-sm transition-colors duration-fast',
        'focus:outline-none focus:bg-bg-hover',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        popoverButtonVariants[variant],
        className
      )}
      // Once focus is in the menu, it follows the pointer when the pointer moves, so a focused item never
      // stays lit beside the hovered one. A menu that opens under a resting pointer gets mouse events with
      // no movement; those leave keyboard focus where it is. Focus elsewhere (the terminal under a link
      // popover) stays put.
      onMouseMove={event => {
        const moved = event.movementX !== 0 || event.movementY !== 0;
        if (moved && event.currentTarget !== document.activeElement && event.currentTarget.closest('[data-terminal-popover]')?.contains(document.activeElement)) event.currentTarget.focus();
        onMouseMove?.(event);
      }}
      {...props}
    >
      {children}
    </button>
  );
};

PopoverButton.displayName = 'PopoverButton';
