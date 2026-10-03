import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../utils/cn';
import { X } from 'lucide-react';
import { PortalContainerProvider } from '../../contexts/PortalContainerContext';
import { useScrollSurface } from '../../hooks/useScrollSurface';
import { useCommittedRef } from '../../hooks/useCommittedRef';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  className?: string;
  ariaLabel?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  restoreFocusOnClose?: boolean;
  /**
   * Opens with no entrance animation at all. Set it on a surface reached by
   * keyboard dozens or hundreds of times a day — the command palette — where an
   * entrance is not polish, it is the gap between pressing the shortcut and
   * being able to type. Raycast's palette has no open animation for exactly
   * this reason.
   */
  instant?: boolean;
}

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) return false;
  if (element.matches(':disabled, [aria-disabled="true"]')) return false;
  return true;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  children,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  className,
  ariaLabel,
  initialFocusRef,
  restoreFocusOnClose = true,
  instant = false,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const didRestoreRef = useRef(false);
  const restoreFocusRef = useCommittedRef(restoreFocusOnClose);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  const restoreOpener = () => {
    if (didRestoreRef.current || !restoreFocusRef.current) return;

    const activeModal = document.activeElement?.closest('[aria-modal="true"]');
    if (activeModal && activeModal !== contentRef.current) return;

    const opener = openerRef.current;
    if (canReceiveFocus(opener)) {
      didRestoreRef.current = true;
      opener.focus();
    }
  };

  useLayoutEffect(() => {
    if (!isOpen) return;

    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Menu items unmount when their action opens a dialog. The menu's ARIA
    // association identifies the persistent trigger to restore on dialog close.
    const menuLabel = focused?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
    const menuTrigger = menuLabel ? document.getElementById(menuLabel) : null;
    openerRef.current = menuTrigger?.matches('[aria-haspopup="menu"]') ? menuTrigger : focused;
    didRestoreRef.current = false;
  }, [isOpen]);
  
  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full',
  };
  
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-modal-backdrop bg-modal-overlay backdrop-blur-sm',
            !instant && 'animate-modal-overlay-enter',
          )}
        />
        <Dialog.Content
          ref={contentRef}
          aria-modal="true"
          aria-describedby={undefined}
          className={cn(
            'fixed inset-0 z-modal m-auto h-fit w-[calc(100%-2rem)] max-h-[calc(100vh-2rem)] outline-none',
            sizeClasses[size],
          )}
          onOpenAutoFocus={(event) => {
            const target = initialFocusRef?.current ?? null;
            if (canReceiveFocus(target)) {
              event.preventDefault();
              target.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreOpener();
          }}
          onEscapeKeyDown={(event) => {
            if (!closeOnEscape) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!closeOnOverlayClick) event.preventDefault();
          }}
        >
          {ariaLabel && <Dialog.Title className="sr-only">{ariaLabel}</Dialog.Title>}
          <PortalContainerProvider value={portalContainer}>
            <div
              className={cn(
                'relative bg-surface-primary border border-border-primary rounded-modal shadow-modal w-full max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col',
                !instant && 'animate-modal-enter',
                className,
              )}
            >
              {showCloseButton && (
                <div className="absolute top-4 right-4 z-10">
                  <button
                    type="button"
                    aria-label="Close modal"
                    onClick={onClose}
                    className="text-text-tertiary hover:text-text-secondary transition-colors p-1 rounded"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>
              )}
              {children}
            </div>
            <div ref={setPortalContainer} className="fixed inset-0 pointer-events-none" />
          </PortalContainerProvider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

Modal.displayName = 'Modal';

// Modal Header component
export interface ModalHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  icon?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
}

export const ModalHeader = React.forwardRef<HTMLDivElement, ModalHeaderProps>(
  ({ className, title, icon, description, actions, onClose, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between px-6 py-4 border-b border-border-primary',
          className
        )}
        {...props}
      >
        <div className="flex min-w-0 items-center gap-2">
          {icon && <div className="text-text-secondary" aria-hidden="true">{icon}</div>}
          <div className="min-w-0">
            <Dialog.Title className="text-heading-2 text-text-primary">
              {title}
            </Dialog.Title>
            {description && <div className="mt-1 text-sm text-text-secondary">{description}</div>}
          </div>
        </div>
        {(actions || onClose) && (
          <div className="ml-4 flex flex-shrink-0 items-center gap-2">
            {actions}
            {onClose && (
              <button
                type="button"
                aria-label="Close modal"
                onClick={onClose}
                className="text-text-tertiary hover:text-text-secondary transition-colors"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
);

ModalHeader.displayName = 'ModalHeader';

// Modal Body component
export interface ModalBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ModalBody = React.forwardRef<HTMLDivElement, ModalBodyProps>(
  ({ className, children, ...props }, ref) => {
    const surfaceId = useId();
    const scrollSurfaceRef = useScrollSurface<HTMLDivElement>({
      id: `modal-body:${surfaceId}`,
      priority: 50,
    });
    const setBodyRef = useCallback((element: HTMLDivElement | null) => {
      scrollSurfaceRef(element);
      if (ref instanceof Function) ref(element);
      else if (ref) ref.current = element;
    }, [ref, scrollSurfaceRef]);

    return (
      <div
        ref={setBodyRef}
        tabIndex={-1}
        className={cn(
          'flex-1 overflow-y-auto px-6 py-4',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ModalBody.displayName = 'ModalBody';

// Modal Footer component
export interface ModalFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ModalFooter = React.forwardRef<HTMLDivElement, ModalFooterProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'px-6 py-4 border-t border-border-primary flex items-center justify-end gap-3',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ModalFooter.displayName = 'ModalFooter';
