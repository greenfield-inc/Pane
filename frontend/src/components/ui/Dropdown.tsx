import React, { useState, useRef, ReactNode, CSSProperties } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '../../utils/cn';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { Kbd } from './Kbd';
import { usePortalContainer } from '../../contexts/PortalContainerContext';

export interface DropdownItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
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

export function Dropdown({
  trigger,
  triggerClassName,
  items,
  selectedId,
  position = 'auto',
  width = 'md',
  closeOnSelect = true,
  onOpenChange,
  footer,
  className,
  menuClassName,
  itemClassName,
  style,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const portalContainer = usePortalContainer();
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  const hasFocusedOnOpen = useRef(false);
  const handleOpenChange = (open: boolean) => {
    hasFocusedOnOpen.current = false;
    setIsOpen(open);
    onOpenChange?.(open);
  };
  const close = () => handleOpenChange(false);
  const MenuItem = selectedId === undefined ? DropdownMenu.Item : DropdownMenu.RadioItem;

  return (
    <div className={cn('relative', className)} style={style}>
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange} modal={false}>
        <DropdownMenu.Trigger asChild className={triggerClassName}>
          {trigger}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer ?? undefined}>
          <DropdownMenu.Content
            ref={contentRef}
            loop
            side={position.startsWith('top') ? 'top' : 'bottom'}
            align={position.endsWith('left') ? 'start' : 'end'}
            sideOffset={8}
            collisionPadding={16}
            onFocusCapture={(event) => {
              if (event.target !== event.currentTarget || hasFocusedOnOpen.current) return;
              hasFocusedOnOpen.current = true;
              // The selected option is identified directly: disabled rows do not
              // change its index. Footer-only menus focus their first menu item.
              const target = selectedItemRef.current ?? contentRef.current?.querySelector<HTMLElement>(
                '[role^="menuitem"]:not([data-disabled])',
              );
              if (target) {
                // Keep the menu's initial content-focus event from applying its
                // default first-item focus after the selected item is focused.
                event.stopPropagation();
                target.focus();
              }
            }}
            className={cn(
              'z-[10000] pointer-events-auto py-1 overflow-y-auto',
              'bg-surface-primary rounded-md shadow-dropdown border border-border-primary',
              width !== 'full' && widthClasses[width],
              menuClassName,
            )}
            style={{
              maxHeight: 'min(70vh, var(--radix-dropdown-menu-content-available-height))',
              maxWidth: 'var(--radix-dropdown-menu-content-available-width)',
              width: width === 'full' ? 'var(--radix-dropdown-menu-trigger-width)' : undefined,
              transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)',
            }}
          >
            <DropdownMenu.RadioGroup value={selectedId}>
              {items.map((item, index) => {
                const Icon = item.icon;
                const isSelected = item.id === selectedId;
                const variant = item.variant || 'default';

                return (
                  <React.Fragment key={item.id}>
                    {index > 0 && items[index - 1].variant !== item.variant && (
                      <div className="h-2" />
                    )}

                    <MenuItem
                      value={item.id}
                      ref={isSelected && !item.disabled ? selectedItemRef : undefined}
                      onSelect={(event) => {
                        if (!closeOnSelect) event.preventDefault();
                        item.onClick?.();
                      }}
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
                          <Icon className={cn(
                            'w-3.5 h-3.5',
                            'stroke-[1.5]',
                            item.iconColor || 'text-current'
                          )} />
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        <div className={cn(
                          'text-[13px] leading-tight truncate',
                          'group-hover:text-inherit'
                        )}>
                          {item.label}
                        </div>
                        {item.description && (
                          <div className="text-[11px] text-text-tertiary mt-0.5 leading-tight">
                            {item.description}
                          </div>
                        )}
                      </div>

                      {item.shortcut && (
                        <Kbd variant="inline" className="shrink-0 pl-3">
                          {formatKeyDisplay(item.shortcut)}
                        </Kbd>
                      )}

                      {(isSelected || item.showDot) && (
                        <div className="flex items-center justify-center w-5 h-5 flex-shrink-0">
                          <div
                            className={cn(
                              'w-2 h-2 rounded-full',
                              isSelected && 'bg-interactive shadow-sm',
                              item.showDot && !isSelected && item.dotColor
                            )}
                          />
                        </div>
                      )}
                    </MenuItem>
                  </React.Fragment>
                );
              })}
            </DropdownMenu.RadioGroup>
            {footer && (
              <>
                <DropdownMenu.Separator className="border-t border-border-secondary my-1.5" />
                {footer instanceof Function ? footer({ close }) : footer}
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
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
    <DropdownMenu.Item asChild disabled={props.disabled}>
      <button
        type="button"
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
    </DropdownMenu.Item>
  );
}
