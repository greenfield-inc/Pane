import type { OuterResizeSeparatorHandlers } from '../../hooks/useOuterPanelResize';

export interface OuterResizeSeparatorProps extends OuterResizeSeparatorHandlers {
  label: string;
  orientation: 'vertical' | 'horizontal';
  value: number;
  minimum: number;
  maximum: number;
  className?: string;
  /** Tooltip; by default says the separator drags and double-click resets. */
  title?: string;
}

export function OuterResizeSeparator({
  label,
  orientation,
  value,
  minimum,
  maximum,
  className = '',
  title = 'Drag to resize. Double-click to reset.',
  ...handlers
}: OuterResizeSeparatorProps) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      tabIndex={0}
      title={title}
      className={`pane-outer-resize-separator pane-outer-resize-separator-${orientation} ${className}`}
      {...handlers}
    >
      <span aria-hidden="true" className="pane-outer-resize-separator-rule" />
    </div>
  );
}
