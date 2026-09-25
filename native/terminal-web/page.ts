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

let lastSize = { cols: 0, rows: 0 };
function refit(): void {
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
        terminal.scrollLines(command.lines);
        break;
      case 'scrollToBottom':
        terminal.scrollToBottom();
        break;
      case 'theme':
        document.body.style.backgroundColor = command.theme.background ?? '';
        terminal.options.theme = command.theme;
        if (terminal.options.fontSize !== command.fontSize) {
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
