// The xterm page that runs inside the terminal WebView. `pnpm build:terminal-web`
// bundles it into src/features/terminal/terminalHtml.generated.ts.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import type { TerminalCommand, TerminalPageEvent } from '../src/features/terminal/bridge';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    paneTerminal: { receive(command: TerminalCommand): void };
  }
}

const post = (event: TerminalPageEvent) => window.ReactNativeWebView?.postMessage(JSON.stringify(event));

const terminal = new Terminal({
  allowProposedApi: true,
  convertEol: true,
  cursorBlink: false,
  fontFamily: 'Menlo, monospace',
  fontSize: 12,
  scrollback: 10_000,
  minimumContrastRatio: 4.5,
  // Touch scrolling is handled below; xterm's own scrollbar only adds clutter on a phone.
  scrollbar: { showScrollbar: false },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
const container = document.getElementById('terminal')!;
terminal.open(container);

// Typing happens in the native input bar. Keep xterm's hidden textarea from
// raising the software keyboard when the terminal is tapped.
const textarea = terminal.textarea;
if (textarea) {
  textarea.setAttribute('inputmode', 'none');
  textarea.readOnly = true;
  textarea.addEventListener('focus', () => textarea.blur());
}

// Focus and mouse reports and replies to terminal queries still go to the host.
terminal.onData(data => post({ type: 'input', data }));

/** The font the phone asked for, and the smallest one a fixed grid shrinks to before it pans. */
let baseFontSize = 12;
const MIN_GRID_FONT_SIZE = 8;
/** The owner's size while watching a terminal this phone may not resize; null fits the terminal to the phone. */
let grid: { cols: number; rows: number } | null = null;

/** Draws the fixed grid in the largest font that fits its width, panning what doesn't fit at the smallest. */
function layoutGrid({ cols, rows }: { cols: number; rows: number }): void {
  const element = terminal.element;
  const screen = element?.querySelector<HTMLElement>('.xterm-screen');
  if (!element || !screen || container.clientWidth <= 0) return;
  const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
  if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
  for (let size = baseFontSize; size >= MIN_GRID_FONT_SIZE; size -= 0.5) {
    if (terminal.options.fontSize !== size) terminal.options.fontSize = size;
    if (screen.offsetWidth <= container.clientWidth) break;
  }
  container.style.overflow = 'hidden';
  element.style.width = `${screen.offsetWidth}px`;
  element.style.height = `${screen.offsetHeight}px`;
  // The prompt sits at the end, so a grid taller than the phone opens there and stays there.
  if (atEnd) container.scrollTop = container.scrollHeight;
}

let panRemainder = 0;
function pan(dx: number, dy: number): void {
  container.scrollLeft += dx;
  const before = container.scrollTop;
  container.scrollTop += dy;
  // scrollTop rounds; only what an edge stopped scrolls the scrollback.
  const stopped = dy < 0 ? container.scrollTop <= 0 : container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
  const rowHeight = (terminal.element?.offsetHeight ?? 0) / terminal.rows;
  if (!stopped || rowHeight <= 0) {
    panRemainder = 0;
    return;
  }
  panRemainder += dy - (container.scrollTop - before);
  const lines = Math.trunc(panRemainder / rowHeight);
  panRemainder -= lines * rowHeight;
  if (lines !== 0) terminal.scrollLines(lines);
}

let lastSize = { cols: 0, rows: 0 };
function refit(): void {
  if (grid) {
    layoutGrid(grid);
    return;
  }
  if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
  fit.fit();
  if (terminal.cols === lastSize.cols && terminal.rows === lastSize.rows) return;
  lastSize = { cols: terminal.cols, rows: terminal.rows };
  post({ type: 'resize', ...lastSize });
}
new ResizeObserver(() => requestAnimationFrame(refit)).observe(container);

// Screen readers get the visible rows as plain text, sent once output settles.
const SCREEN_TEXT_SETTLE_MS = 300;
let screenTimer = 0;
let lastScreenText = '';
function scheduleScreenText(): void {
  clearTimeout(screenTimer);
  screenTimer = window.setTimeout(() => {
    const buffer = terminal.buffer.active;
    const rows: string[] = [];
    for (let row = 0; row < terminal.rows; row++) {
      rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    }
    const text = rows.join('\n').trimEnd();
    if (text === lastScreenText) return;
    lastScreenText = text;
    post({ type: 'screen', text });
  }, SCREEN_TEXT_SETTLE_MS);
}
terminal.onWriteParsed(scheduleScreenText);

let atBottom = true;
terminal.onScroll(() => {
  scheduleScreenText();
  const buffer = terminal.buffer.active;
  const next = buffer.viewportY >= buffer.baseY;
  if (next === atBottom) return;
  atBottom = next;
  post({ type: 'scrolled', atBottom });
});

/**
 * Scrolls by `lines` (negative is up). A full-screen app on the alternate
 * screen, or any app that asked for mouse events, keeps no scrollback here and
 * scrolls itself, so it gets wheel input: one wheel line per line. xterm turns
 * each into a mouse-wheel report when the app asked for mouse events, or an
 * arrow key otherwise, just as it does for a desktop mouse wheel.
 */
function scroll(lines: number): void {
  const appScrolls = terminal.buffer.active.type === 'alternate' || terminal.modes.mouseTrackingMode !== 'none';
  if (!appScrolls) {
    terminal.scrollLines(lines);
    return;
  }
  const screen = terminal.element?.querySelector('.xterm-screen');
  if (!screen) return;
  const box = screen.getBoundingClientRect();
  for (let line = 0; line < Math.abs(lines); line++) {
    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY: Math.sign(lines),
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      bubbles: true,
      cancelable: true,
    }));
  }
}

function write(data: string): void {
  terminal.write(data, () => post({ type: 'written', units: data.length }));
}

window.paneTerminal = {
  receive(command) {
    switch (command.type) {
      case 'reset':
        terminal.reset();
        if (command.data) terminal.write(command.data);
        break;
      case 'write':
        write(command.data);
        break;
      case 'scroll':
        scroll(command.lines);
        break;
      case 'scrollToBottom':
        terminal.scrollToBottom();
        if (grid) container.scrollTop = container.scrollHeight;
        break;
      case 'grid':
        grid = { cols: command.cols, rows: command.rows };
        layoutGrid(grid);
        break;
      case 'pan':
        pan(command.dx, command.dy);
        break;
      case 'theme':
        document.body.style.backgroundColor = command.theme.background ?? '';
        terminal.options.theme = command.theme;
        if (baseFontSize !== command.fontSize) {
          baseFontSize = command.fontSize;
          terminal.options.fontSize = command.fontSize;
          refit();
        }
        break;
    }
  },
};

fit.fit();
lastSize = { cols: terminal.cols, rows: terminal.rows };
post({ type: 'ready', ...lastSize });
