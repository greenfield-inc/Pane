import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Copy, Eraser, MessageSquarePlus, Undo2, X } from 'lucide-react';
import { cn } from '../../../utils/cn';

export interface DeviceMarkupProps {
  /** The screenshot to draw on, as a PNG or JPEG data URL, at the device's full resolution. */
  image: string;
  /** Whether this Pane has an agent tab to send to; hides "Send to chat" when false. */
  canSendToChat: boolean;
  /** The drawing flattened onto the screenshot, as a PNG, and what to do with it. */
  onDone: (png: Blob, action: 'chat' | 'copy') => void;
  onCancel: () => void;
}

/** A point in the screenshot's own pixels. */
interface Point { x: number; y: number }
type Stroke = Point[];

/** The stroke color when the theme does not set `--color-interactive-primary`. */
const FALLBACK_COLOR = '#e5484d';

/** Draws strokes given in image pixels onto a context, multiplied by `scale`. */
function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number, width: number, color: string) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    if (rest.length === 0) {
      ctx.beginPath();
      ctx.arc(first.x * scale, first.y * scale, (width * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(first.x * scale, first.y * scale);
    for (const point of rest) ctx.lineTo(point.x * scale, point.y * scale);
    ctx.stroke();
  }
}

/**
 * Mark up: the frozen screenshot over the device area, letterboxed to fit, with freehand drawing in
 * the theme's accent color. Done flattens the drawing onto the full-resolution screenshot as a PNG.
 */
export function DeviceMarkup({ image, canSendToChat, onDone, onCancel }: DeviceMarkupProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef<Stroke | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const [box, setBox] = useState<{ width: number; height: number }>();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color] = useState(() => getComputedStyle(document.documentElement).getPropertyValue('--color-interactive-primary').trim() || FALLBACK_COLOR);
  const strokeWidth = natural ? Math.max(natural.width, natural.height) * 0.006 : 0;

  // The displayed box is the largest one with the screenshot's shape that fits the area.
  useEffect(() => {
    const area = areaRef.current;
    if (!area || !natural) return;
    const fit = () => {
      const scale = Math.min(area.clientWidth / natural.width, area.clientHeight / natural.height);
      setBox({ width: Math.floor(natural.width * scale), height: Math.floor(natural.height * scale) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    return () => observer.disconnect();
  }, [natural]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !natural || !box) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
    const active = activeRef.current;
    drawStrokes(ctx, active ? [...strokes, active] : strokes, canvas.width / natural.width, strokeWidth, color);
  }, [box, natural, strokes, strokeWidth, color]);

  useEffect(redraw, [redraw]);

  const toImagePoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point | undefined => {
    if (!natural) return undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * natural.width, y: ((event.clientY - rect.top) / rect.height) * natural.height };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toImagePoint(event);
    if (!point || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activeRef.current = [point];
    redraw();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toImagePoint(event);
    if (!point || !activeRef.current) return;
    activeRef.current.push(point);
    redraw();
  };
  const endStroke = () => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    setStrokes(previous => [...previous, active]);
  };

  const undo = useCallback(() => setStrokes(previous => previous.slice(0, -1)), []);

  const finish = useCallback((action: 'chat' | 'copy') => {
    const img = imageRef.current;
    if (!img || !natural) return;
    const canvas = document.createElement('canvas');
    canvas.width = natural.width;
    canvas.height = natural.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, natural.width, natural.height);
    drawStrokes(ctx, strokes, 1, strokeWidth, color);
    canvas.toBlob(blob => { if (blob) onDone(blob, action); }, 'image/png');
  }, [natural, strokes, strokeWidth, color, onDone]);

  // Keys while Mark up has focus (it takes focus when it opens): Escape cancels, ⌘Z / Ctrl+Z
  // undoes, ⌘Enter / Ctrl+Enter sends to chat (or copies without one).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') onCancel();
    else if (mod && !event.shiftKey && event.key.toLowerCase() === 'z') undo();
    else if (mod && event.key === 'Enter') finish(canSendToChat ? 'chat' : 'copy');
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKey} className="absolute inset-0 z-10 flex flex-col gap-2 bg-bg-primary/90 p-4 outline-none" data-testid="device-markup">
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center">
        <div className="relative overflow-hidden rounded shadow-sm" style={box ? { width: box.width, height: box.height } : { visibility: 'hidden' }}>
          <img
            ref={imageRef}
            src={image}
            alt="Screenshot to mark up"
            draggable={false}
            className="block h-full w-full select-none"
            onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
            data-testid="device-markup-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
          />
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <MarkupButton label="Undo" disabled={strokes.length === 0} onClick={undo}><Undo2 className="h-3.5 w-3.5" /></MarkupButton>
        <MarkupButton label="Clear" disabled={strokes.length === 0} onClick={() => setStrokes([])}><Eraser className="h-3.5 w-3.5" /></MarkupButton>
        <span className="flex-1" />
        <MarkupButton label="Cancel" onClick={onCancel}><X className="h-3.5 w-3.5" /></MarkupButton>
        <MarkupButton label="Copy" disabled={!natural} onClick={() => finish('copy')}><Copy className="h-3.5 w-3.5" /></MarkupButton>
        {canSendToChat && <MarkupButton label="Send to chat" primary disabled={!natural} onClick={() => finish('chat')}><MessageSquarePlus className="h-3.5 w-3.5" /></MarkupButton>}
      </div>
    </div>
  );
}

function MarkupButton({ label, primary, disabled, onClick, children }: { label: string; primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium disabled:opacity-60',
        primary ? 'bg-interactive text-text-on-interactive hover:bg-interactive-hover' : 'border border-border-primary bg-surface-primary text-text-primary hover:bg-surface-hover',
      )}
    >
      {children}
      {label}
    </button>
  );
}
