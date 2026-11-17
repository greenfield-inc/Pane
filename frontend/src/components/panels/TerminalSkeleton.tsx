import { useMemo } from 'react';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../../../shared/types/appearance';
import { useConfigStore } from '../../stores/configStore';
import { buildTerminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY } from '../../utils/terminalTheme';
import type { Terminal } from '@xterm/xterm';
import { wasTerminalRevealed } from '../../utils/revealedTerminals';
import { Skeleton } from '../ui/Skeleton';

/** Where xterm draws its first cell (index.css `.xterm` padding plus `.xterm-screen` margin). */
const SCREEN_LEFT_PX = 12;
const SCREEN_TOP_PX = 9;
/** Bones cover the middle of a cell's height, like a line of text. */
const BONE_HEIGHT_RATIO = 0.5;

/** One row's text extent in cells, [first non-blank, end); [0, 0] is a blank row. */
type RowExtent = readonly [number, number];

/**
 * A screen of transcript for a terminal never shown in this window: wrapped
 * paragraphs with blank lines between them, the way an agent's output reads.
 */
const TRANSCRIPT: readonly RowExtent[] = [
  [0, 46], [2, 71], [2, 64], [0, 0],
  [0, 58], [2, 77], [2, 69], [2, 40], [0, 0],
  [0, 36], [2, 74], [2, 52], [0, 0],
  [0, 62], [2, 80], [2, 75], [2, 66], [2, 28], [0, 0],
  [0, 49], [2, 72], [2, 57], [0, 0],
];
/** Enough rows for a tall window; the surface clips the rest. */
const TRANSCRIPT_SCREEN = [...TRANSCRIPT, ...TRANSCRIPT, ...TRANSCRIPT, ...TRANSCRIPT];

interface CellSize { width: number; height: number }

/** Cell sizes by xterm font (`${size}px ${family}`): taken from revealed terminals, else measured. */
const cellSizes = new Map<string, CellSize>();

/** Records a revealed terminal's real cell, so later skeletons for its font sit exactly on its rows. */
export function noteTerminalCell(terminal: Terminal, screen: Element): void {
  if (terminal.rows <= 0 || terminal.cols <= 0) return;
  const box = screen.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return;
  cellSizes.set(`${terminal.options.fontSize}px ${terminal.options.fontFamily}`, { width: box.width / terminal.cols, height: box.height / terminal.rows });
}

/**
 * The cell xterm lays text out on for this font, measured the way xterm does:
 * the canvas font box, rounded to device pixels (height up, width down).
 */
function measureCell(fontFamily: string, fontSize: number): CellSize {
  const key = `${fontSize}px ${fontFamily}`;
  const known = cellSizes.get(key);
  if (known) return known;
  const fallback = { width: fontSize * 0.6, height: Math.ceil(fontSize * 1.3) };
  // Server rendering (tests) has no document to measure in.
  const context = globalThis.document?.createElement('canvas').getContext('2d');
  if (!context) return fallback;
  context.font = key;
  const metrics = context.measureText('W');
  const ratio = window.devicePixelRatio || 1;
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const cell = height > 0 && metrics.width > 0
    ? { width: Math.floor(metrics.width * ratio) / ratio, height: Math.ceil(height * ratio) / ratio }
    : fallback;
  // A font still loading measures as its fallback; only keep a real measure.
  let loaded = true;
  try { loaded = document.fonts?.check?.(key) !== false; } catch { loaded = false; }
  if (loaded) cellSizes.set(key, cell);
  return cell;
}

/**
 * The loading skeleton of a terminal: one bone per line of text, on xterm's
 * own cell grid. A terminal this window revealed before is cached content and
 * gets the plain surface, with no bones.
 */
export function TerminalSkeleton({ panelId, chain }: {
  /** The terminal this stands in for, when known. */
  panelId?: string;
  /** The Pane or Session being opened (Skeleton's `chain`). */
  chain?: string;
}) {
  const fontFamily = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const fontSize = useConfigStore(state => state.config?.terminalFontSize) || DEFAULT_TERMINAL_FONT_SIZE;
  const cell = useMemo(() => measureCell(buildTerminalFontFamily(fontFamily), fontSize), [fontFamily, fontSize]);
  const boneHeight = Math.round(cell.height * BONE_HEIGHT_RATIO);
  if (panelId && wasTerminalRevealed(panelId)) return <div aria-hidden="true" className="absolute inset-0" />;

  return (
    <Skeleton testId="terminal-skeleton" chain={chain} className="absolute inset-0"
      style={{ paddingLeft: SCREEN_LEFT_PX, paddingTop: SCREEN_TOP_PX }}>
      {TRANSCRIPT_SCREEN.map(([start, end], row) => (
        <div key={row} className="relative" style={{ height: cell.height }}>
          {end > start && (
            <div className="skeleton-bone absolute rounded-sm bg-surface-tertiary" style={{
              left: start * cell.width,
              width: (end - start) * cell.width,
              top: (cell.height - boneHeight) / 2,
              height: boneHeight,
            }} />
          )}
        </div>
      ))}
    </Skeleton>
  );
}
