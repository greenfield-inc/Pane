import React, { useState, useRef, useEffect, useLayoutEffect, useId, useCallback, ReactNode, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../../utils/cn';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { Kbd } from './Kbd';
import { initialActiveIndex } from './dropdownNavigation';
import { usePortalContainer } from '../../contexts/PortalContainerContext';
import { Tooltip } from './Tooltip';

export interface DropdownItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  descriptionInTooltip?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  iconColor?: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'success' | 'warning' | 'danger';
  showDot?: boolean;
  dotColor?: string;
  shortcut?: string;
}

export interface DropdownProps {
  // Trigger element
  trigger: React.ReactElement;
  triggerClassName?: string;
  
  // Items
  items: DropdownItem[];
  selectedId?: string;
  
  // Appearance
  position?: 'auto' | 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  width?: 'auto' | 'sm' | 'md' | 'lg' | 'full';
  
  // Behavior
  closeOnSelect?: boolean;
  separateVariants?: boolean;
  onOpenChange?: (open: boolean) => void;
  
  // Optional footer content (e.g., settings button)
  footer?: ReactNode | ((controls: { close: () => void }) => ReactNode);
  
  // Custom styles
  className?: string;
  menuClassName?: string;
  itemClassName?: string;
  style?: CSSProperties;
}

const widthClasses = {
  auto: 'w-auto',
  sm: 'w-48',
  md: 'w-56',
  lg: 'w-64',
  full: 'w-full',
};

const variantStyles = {
  default: 'text-text-secondary hover:bg-interactive/10 hover:text-text-primary hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]',
  success: 'text-status-success hover:bg-interactive/10 hover:text-text-primary hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]',
  warning: 'text-status-warning hover:bg-interactive/10 hover:text-text-primary hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]',
  danger: 'text-status-error hover:bg-interactive/10 hover:text-text-primary hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]',
};

const selectedVariantStyles = {
  default: 'bg-interactive/15 text-interactive shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)] border border-interactive/30',
  success: 'bg-interactive/15 text-status-success shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)] border border-status-success/30',
  warning: 'bg-interactive/15 text-status-warning shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)] border border-status-warning/30',
  danger: 'bg-interactive/15 text-status-error shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)] border border-status-error/30',
};

function getMenuControls(content: HTMLElement | null): HTMLElement[] {
  if (!content) return [];

  return Array.from(content.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ));
}

export function Dropdown({
  trigger,
  triggerClassName,
  items,
  selectedId,
  position = 'auto',
  width = 'md',
  closeOnSelect = true,
  separateVariants = true,
  onOpenChange,
  footer,
  className,
  menuClassName,
  itemClassName,
  style,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [, setActualPosition] = useState<'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'>('bottom-right');
  const [activeIndex, setActiveIndex] = useState(-1);
  const menuId = useId();
  const portalContainer = usePortalContainer();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement>(null);

  const handleToggle = () => {
    const newState = !isOpen;
    setActiveIndex(newState ? initialActiveIndex(items, selectedId) : -1);
    setIsOpen(newState);
    onOpenChange?.(newState);
  };

  const handleClose = useCallback(() => {
    // Focus inside the menu would land on <body> when it unmounts, so hand it back to
    // the trigger. Focus already moved elsewhere (a click on another control) is left alone.
    const focusWasInMenu = !!contentRef.current?.contains(document.activeElement);

    setIsOpen(false);
    onOpenChange?.(false);

    if (focusWasInMenu) {
      triggerRef.current?.focus();
    }
  }, [onOpenChange]);

  const handleItemClick = (item: DropdownItem) => {
    if (item.disabled) return;

    item.onClick?.();

    if (closeOnSelect) {
      handleClose();
    }
  };

  // Seeded from the current selection, so e.g. the theme menu opens on the active theme.
  // Re-runs on item count: a shrinking list would otherwise strand activeIndex out of
  // range, leaving every item at tabIndex={-1} with no reachable highlight.
  useEffect(() => {
    if (!isOpen) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((current) =>
      current >= 0 && current < items.length && !items[current].disabled
        ? current
        : initialActiveIndex(items, selectedId),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, items.length]);

  // Roving tabindex: DOM focus follows the active item. If there are no regular
  // items, focus the first footer control so footer-only menus remain usable.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const controls = getMenuControls(contentRef.current);
    const target = controls[activeIndex] ?? controls[0];
    target?.focus();
  }, [isOpen, activeIndex]);

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const controls = getMenuControls(contentRef.current);
        if (controls.length === 0) break;

        // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = current === -1
          ? (step === 1 ? 0 : controls.length - 1)
          : (current + step + controls.length) % controls.length;
        setActiveIndex(next);
        break;
      }
      case 'Enter':
      case ' ': {
        // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
        const itemIndex = Number((document.activeElement as HTMLElement)?.dataset.dropdownItemIndex);
        if (Number.isInteger(itemIndex) && items[itemIndex]) {
          event.preventDefault();
          handleItemClick(items[itemIndex]);
        }
        // Footer controls keep their native Enter/Space behavior.
        break;
      }
      case 'Tab':
        // Deliberately not preventDefault: close, and let Tab continue from the trigger
        // that handleClose refocuses. Otherwise focus escapes the portal (which sits at
        // the end of <body>) while the menu stays open.
        handleClose();
        break;
      // Escape is handled by the document listener below.
      default:
        break;
    }
  };

  // Fixed position for portal rendering
  const [fixedStyle, setFixedStyle] = useState<CSSProperties>({});

  // Smart positioning for auto mode. Must run BEFORE paint: fixedStyle
  // persists across closes, so the first open after mount used to paint the
  // portal unpositioned (static flow at the end of the portal container —
  // off-screen) until a post-paint effect corrected it, and the correction
  // only became visible on the SECOND open. While open, a rAF loop re-anchors
  // the menu whenever the trigger actually moves (drawer expand animation,
  // layout shifts, window resizes).
  useLayoutEffect(() => {
    if (!isOpen || !dropdownRef.current) return;

    let lastRectKey = '';
    const computePosition = () => {
      const el = dropdownRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const rectKey = `${rect.top},${rect.left},${rect.width},${rect.height}`;
      if (rectKey === lastRectKey) return;
      lastRectKey = rectKey;

      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      // If there's less than 200px below the element, show it above
      const spaceBelow = viewportHeight - rect.bottom;
      const shouldShowAbove = spaceBelow < 200;

      if (position === 'auto') {
        setActualPosition(shouldShowAbove ? 'top-right' : 'bottom-right');
      } else {
        setActualPosition(position);
      }

      // Calculate fixed position for portal
      const gap = 8;
      const edgePadding = 16; // breathing room from viewport edge
      const pos: CSSProperties = { position: 'fixed' };
      if (shouldShowAbove || position === 'top-left' || position === 'top-right') {
        pos.bottom = viewportHeight - rect.top + gap;
        pos.maxHeight = rect.top - gap - edgePadding;
      } else {
        pos.top = rect.bottom + gap;
        pos.maxHeight = viewportHeight - rect.bottom - gap - edgePadding;
      }
      pos.overflowY = 'auto';
      // Horizontal anchor. `*-left` positions hang the menu from the trigger's
      // left edge, `*-right` from its right edge; either way the menu flips to
      // the side that keeps it inside the viewport (a trigger beside the window
      // controls has no room to its left).
      const menuWidth = contentRef.current?.offsetWidth ?? 224;
      const wantsLeft = position === 'bottom-left' || position === 'top-left';
      const fitsLeftAligned = rect.left + menuWidth <= viewportWidth - 8;
      const fitsRightAligned = rect.right - menuWidth >= 8;
      const alignLeft = wantsLeft ? (fitsLeftAligned || !fitsRightAligned) : (!fitsRightAligned && fitsLeftAligned);
      if (alignLeft) {
        pos.left = Math.max(8, Math.min(rect.left, viewportWidth - 8 - menuWidth));
      } else {
        pos.right = Math.max(8, viewportWidth - rect.right);
      }
      // When width="full", match the trigger's width instead of using CSS w-full
      // (portal renders to body, so w-full = viewport width, not trigger width)
      if (width === 'full') {
        pos.width = rect.width;
        pos.left = rect.left;
        delete pos.right;
      }
      setFixedStyle(pos);
    };

    computePosition();
    let raf = requestAnimationFrame(function track() {
      computePosition();
      raf = requestAnimationFrame(track);
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, position, width]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (event.target && event.target instanceof Node) {
        const inTrigger = dropdownRef.current?.contains(event.target);
        const inContent = contentRef.current?.contains(event.target);
        if (!inTrigger && !inContent) {
          handleClose();
        }
      }
    };

    // Add a small delay to prevent immediate closing when clicking the trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, handleClose]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, handleClose]);

  return (
    <div ref={dropdownRef} className={cn('relative', className)} style={style}>
      {/* Trigger */}
      <Slot
        ref={triggerRef}
        onClick={handleToggle}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !isOpen) {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        {trigger}
      </Slot>

      {/* Dropdown Menu - rendered via portal to escape overflow clipping */}
      {isOpen && createPortal(
        <div
          id={menuId}
          ref={contentRef}
          role="menu"
          aria-orientation="vertical"
          onKeyDown={handleMenuKeyDown}
          className={cn(
            'z-[10000] pointer-events-auto',
            'bg-surface-primary rounded-md shadow-dropdown',
            'border border-border-primary',
            'overflow-hidden',
            width !== 'full' && widthClasses[width],
            menuClassName
          )}
          style={{
            ...fixedStyle,
            // Grow out of the trigger rather than out of thin air. The menu is
            // anchored by whichever pair of edges `computePosition` pinned it
            // with, so those edges are exactly where the trigger is — scaling
            // from that corner is what makes the menu look like it came from the
            // button you pressed instead of appearing over it.
            transformOrigin: `${fixedStyle.bottom !== undefined ? 'bottom' : 'top'} ${fixedStyle.right !== undefined ? 'right' : 'left'}`,
          }}
        >
            <div className="py-1 max-h-[70vh] overflow-y-auto">
              {items.map((item, index) => {
                const Icon = item.icon;
                const isSelectable = selectedId !== undefined;
                const isSelected = item.id === selectedId;
                const variant = item.variant || 'default';
                const menuButton = (
                    <button
                      type="button"
                      data-dropdown-item-index={index}
                      role={isSelectable ? 'menuitemradio' : 'menuitem'}
                      aria-checked={isSelectable ? isSelected : undefined}
                      tabIndex={index === activeIndex ? 0 : -1}
                      onClick={() => handleItemClick(item)}
                      onMouseEnter={() => !item.disabled && setActiveIndex(index)}
                      disabled={item.disabled}
                      className={cn(
                        'w-full text-left px-2.5 py-1',
                        'flex items-center gap-2',
                        'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus-ring-subtle',
                        'min-h-[1.75rem] group relative',
                        item.disabled && 'opacity-50 cursor-not-allowed',
                        !item.disabled && !isSelected && variantStyles[variant],
                        isSelected && selectedVariantStyles[variant],
                        itemClassName
                      )}
                    >
                      {Icon && (
                        <div className="flex items-center justify-center w-4 h-4 flex-shrink-0">
                          <Icon className={cn('w-3.5 h-3.5', 'stroke-[1.5]', item.iconColor || 'text-current')} />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className={cn('text-[13px] leading-tight truncate', 'group-hover:text-inherit')}>{item.label}</div>
                        {item.description && !item.descriptionInTooltip && (
                          <div className="text-[11px] text-text-tertiary mt-0.5 leading-tight">{item.description}</div>
                        )}
                      </div>
                      {item.shortcut && <Kbd variant="inline" className="shrink-0 pl-3">{formatKeyDisplay(item.shortcut)}</Kbd>}
                      {(isSelected || item.showDot) && (
                        <div className="flex items-center justify-center w-5 h-5 flex-shrink-0">
                          <div className={cn('w-2 h-2 rounded-full', isSelected && 'bg-interactive shadow-sm', item.showDot && !isSelected && item.dotColor)} />
                        </div>
                      )}
                    </button>
                );

                return (
                  <React.Fragment key={item.id}>
                    {separateVariants && index > 0 && items[index - 1].variant !== item.variant && (
                      <div className="h-2" />
                    )}

                    {item.description && item.descriptionInTooltip
                      ? <Tooltip content={item.description} side="right" delay={250}>{menuButton}</Tooltip>
                      : menuButton}
                  </React.Fragment>
                );
              })}

              {footer && (
                <>
                  <div className="border-t border-border-secondary my-1.5" />
                  {footer instanceof Function ? footer({ close: handleClose }) : footer}
                </>
              )}
            </div>
        </div>,
        portalContainer ?? document.body
      )}
    </div>
  );
}

// Dropdown Menu Item component for custom footer items
export function DropdownMenuItem({
  icon: Icon,
  label,
  onClick,
  className,
  ...props
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: ReactNode;
  onClick?: () => void;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-2.5 py-1',
        'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        'flex items-center gap-2',
        'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-focus-ring-subtle',
        'min-h-[1.75rem] group',
        className
      )}
      {...props}
    >
      {Icon && (
        <div className="flex items-center justify-center w-4 h-4 flex-shrink-0">
          <Icon className="w-3.5 h-3.5 text-text-tertiary group-hover:text-current stroke-[1.5]" />
        </div>
      )}
      <span className="text-[13px] group-hover:text-inherit">{label}</span>
    </button>
  );
}
