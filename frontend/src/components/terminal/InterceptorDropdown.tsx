import React, { useRef, useState, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { Kbd } from '../ui/Kbd';
import type { TerminalSuggestion, PasteMode } from '../../services/terminalInterceptor/types';
import { AT_TERMINAL_LINE_COUNT_PRESETS as LINE_COUNT_PRESETS } from '../../types/settings';
import { LiveRegion } from '../ui/LiveRegion';

interface InterceptorDropdownProps {
  visible: boolean;
  terminals: TerminalSuggestion[];
  selectedIndex: number;
  lineCountPresetIndex: number;
  pasteMode: PasteMode;
  filterText: string;
  position: { x: number; y: number };
}

function formatPresetLabel(value: number): string {
  return value === -1 ? 'All' : String(value);
}

export const InterceptorDropdown: React.FC<InterceptorDropdownProps> = ({
  visible,
  terminals,
  selectedIndex,
  lineCountPresetIndex,
  pasteMode,
  filterText,
  position,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  const [resolvedPosition, setResolvedPosition] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);

  // Trigger mount animation on next frame
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => setMounted(true));
    }
    return () => setMounted(false);
  }, [visible]);

  // Smart positioning to keep dropdown on screen
  useLayoutEffect(() => {
    if (!visible || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let top = position.y;
    let left = position.x;

    if (top + rect.height > viewportHeight - 10) {
      top = position.y - rect.height;
    }
    if (left + rect.width > viewportWidth - 10) {
      left = viewportWidth - rect.width - 10;
    }
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    setResolvedPosition({ top, left });
  }, [visible, position.x, position.y]);

  // Scroll the selected item into view
  useEffect(() => {
    if (!visible || !selectedItemRef.current) return;
    selectedItemRef.current.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, visible]);

  const selectedTerminal = terminals[selectedIndex];
  const announcement = visible && selectedTerminal
    ? `${selectedTerminal.title}, ${formatPresetLabel(LINE_COUNT_PRESETS[lineCountPresetIndex])} lines, ${pasteMode} mode`
    : '';

  return (
    <>
      <LiveRegion>{announcement}</LiveRegion>
      {visible && createPortal(
    <div
      ref={containerRef}
      className={cn(
        'fixed z-[10001] min-w-[300px] max-w-[420px]',
        'bg-surface-primary/95 backdrop-blur-md overflow-hidden',
        'border border-border-primary rounded-none shadow-dropdown-elevated',
        'will-change-[transform,opacity]',
        mounted ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-1 scale-[0.98]',
      )}
      style={{
        left: resolvedPosition.left,
        top: resolvedPosition.top,
        transition: 'opacity 120ms cubic-bezier(0.16, 1, 0.3, 1), transform 120ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Filter header — only when filtering */}
      {filterText && (
        <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border-subtle">
          <span className="font-mono text-text-secondary">@{filterText}</span>
        </div>
      )}

      {/* Terminal entries */}
      <div className="max-h-[220px] overflow-y-auto py-1">
        {terminals.map((terminal, index) => {
          const isSelected = index === selectedIndex;
          const isNoOutput =
            terminal.preview.length === 1 && terminal.preview[0] === '(no output)';

          return (
            <div
              key={terminal.panelId}
              ref={isSelected ? selectedItemRef : null}
              className={cn(
                'px-3 py-1.5 cursor-default transition-colors duration-75',
                isSelected && 'bg-bg-hover',
              )}
            >
              <div className="text-[13px] font-medium text-text-primary leading-tight">
                {terminal.title}
              </div>
              <div className="text-[11px] text-text-tertiary font-mono mt-0.5 leading-snug overflow-hidden opacity-70">
                {isNoOutput ? (
                  <span className="italic">{terminal.preview[0]}</span>
                ) : (
                  terminal.preview.map((line, i) => (
                    <div key={i} className="truncate">{line}</div>
                  ))
                )}
              </div>
            </div>
          );
        })}
        {terminals.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-tertiary italic">Loading...</div>
        )}
      </div>

      {/* Line count + mode controls */}
      <div className="px-3 py-2 border-t border-border-subtle flex items-center justify-between">
        {/* Line count */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-text-quaternary mr-0.5">Lines</span>
          {LINE_COUNT_PRESETS.map((preset, i) => (
            <span
              key={preset}
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-md font-mono transition-all duration-75',
                i === lineCountPresetIndex
                  ? 'bg-accent-primary text-white font-semibold shadow-sm'
                  : 'text-text-tertiary',
              )}
            >
              {formatPresetLabel(preset)}
            </span>
          ))}
        </div>
        {/* Paste mode */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-[11px] px-2 py-0.5 rounded-md transition-all duration-75',
              pasteMode === 'raw'
                ? 'bg-surface-tertiary text-text-primary font-medium'
                : 'text-text-quaternary',
            )}
          >
            Raw
          </span>
          <span
            className={cn(
              'text-[11px] px-2 py-0.5 rounded-md transition-all duration-75',
              pasteMode === 'embed'
                ? 'bg-surface-tertiary text-text-primary font-medium'
                : 'text-text-quaternary',
            )}
          >
            Embed
          </span>
        </div>
      </div>

      {/* Footer hints with kbd */}
      <div className="px-3 py-1.5 border-t border-border-subtle flex items-center justify-center gap-2.5 text-[11px] text-text-quaternary">
        <span className="inline-flex items-center gap-1">
          <Kbd size="xs" variant="muted">↑↓</Kbd>
          <span>select</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd size="xs" variant="muted">←→</Kbd>
          <span>lines</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd size="xs" variant="muted">Tab</Kbd>
          <span>mode</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd size="xs" variant="muted">Enter</Kbd>
          <span>paste</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd size="xs" variant="muted">Esc</Kbd>
          <span>cancel</span>
        </span>
      </div>
    </div>,
    document.body
      )}
    </>
  );
};

InterceptorDropdown.displayName = 'InterceptorDropdown';
