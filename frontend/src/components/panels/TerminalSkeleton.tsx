import { useMemo } from 'react';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../../../shared/types/appearance';
import { useConfigStore } from '../../stores/configStore';
import { buildTerminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY } from '../../utils/terminalTheme';
import { rememberedTerminalScreen, type TerminalRowExtent } from '../../utils/terminalScreens';
import { Skeleton } from '../ui/Skeleton';

/** Where xterm draws its first cell (index.css `.xterm` padding plus `.xterm-screen` margin). */
const SCREEN_LEFT_PX = 12;
const SCREEN_TOP_PX = 9;
/** Bones cover the middle of a cell's height, like a line of text. */
const BONE_HEIGHT_RATIO = 0.5;

/**
 * A screen of transcript for a terminal never shown in this window: wrapped
 * paragraphs with blank lines between them, the way an agent's output reads.
 */
const TRANSCRIPT: readonly TerminalRowExtent[] = [
  [0, 46], [2, 71], [2, 64], [0, 0],
  [0, 58], [2, 77], [2, 69], [2, 40], [0, 0],
  [0, 36], [2, 74], [2, 52], [0, 0],
  [0, 62], [2, 80], [2, 75], [2, 66], [2, 28], [0, 0],
  [0, 49], [2, 72], [2, 57], [0, 0],
];
/** Enough rows for a tall window; the surface clips the rest. */
const TRANSCRIPT_SCREEN = [...TRANSCRIPT, ...TRANSCRIPT, ...TRANSCRIPT, ...TRANSCRIPT];

interface CellSize { width: number; height: number }

const cellSizes = new Map<string, CellSize>();

/**
 * The cell xterm lays text out on for this font: it measures the font's
 * glyph box, rounds the height up to a whole pixel and the width down to a
 * device pixel.
 */
function measureCell(fontFamily: string, fontSize: number): CellSize {
  const key = `${fontSize}px ${fontFamily}`;
  const known = cellSizes.get(key);
  if (known) return known;
  if (typeof document === 'undefined') return { width: fontSize * 0.6, height: Math.ceil(fontSize * 1.3) };
  const probe = document.createElement('span');
  probe.textContent = 'W'.repeat(32);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;line-height:normal;font-size:${fontSize}px;font-family:${fontFamily}`;
  document.body.append(probe);
  const box = probe.getBoundingClientRect();
  probe.remove();
  const ratio = window.devicePixelRatio || 1;
  const cell = box.height > 0
    ? { width: Math.floor((box.width / 32) * ratio) / ratio, height: Math.ceil(box.height) }
    : { width: fontSize * 0.6, height: Math.ceil(fontSize * 1.3) };
  // A font still loading measures as its fallback; only keep a real measure.
  if (document.fonts?.check?.(`${fontSize}px ${fontFamily}`) !== false) cellSizes.set(key, cell);
  return cell;
}

/**
 * The loading skeleton of a terminal: one bone per line of text, on xterm's
 * own cell grid. A terminal shown before draws the screen it left.
 */
export function TerminalSkeleton({ panelId }: { panelId?: string }) {
  const fontFamily = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const fontSize = useConfigStore(state => state.config?.terminalFontSize) || DEFAULT_TERMINAL_FONT_SIZE;
  const cell = useMemo(() => measureCell(buildTerminalFontFamily(fontFamily), fontSize), [fontFamily, fontSize]);
  const rows = (panelId && rememberedTerminalScreen(panelId)) || TRANSCRIPT_SCREEN;
  const boneHeight = Math.round(cell.height * BONE_HEIGHT_RATIO);

  return (
    <Skeleton testId="terminal-skeleton" className="absolute inset-0"
      style={{ paddingLeft: SCREEN_LEFT_PX, paddingTop: SCREEN_TOP_PX }}>
      {rows.map(([start, end], row) => (
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
