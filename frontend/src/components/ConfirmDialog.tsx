import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
  icon?: ReactNode;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  icon
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" ariaLabel={title} initialFocusRef={confirmRef}>
      <div className="p-6 pt-2">
        <div className="flex items-start gap-3 mb-4">
          {icon && <div className="flex-shrink-0">{icon}</div>}
          <h3 className="text-lg font-medium text-text-primary">{title}</h3>
        </div>
        <p className="text-text-secondary whitespace-pre-line leading-relaxed mb-6">
          {message}
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>{cancelText}</Button>
          <Button variant={variant} onClick={handleConfirm} ref={confirmRef}>{confirmText}</Button>
        </div>
      </div>
    </Modal>
  );
}
