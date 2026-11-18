import { PaneError } from '../../../../shared/paneError';
import { attachDebugger, type DebuggableContents } from '../debuggerLifetime';
import { PANE_WORLD_ID, pageCall } from './pageScript';

/**
 * The debugger methods the page driver may send, and nothing else: no Target, Browser, Storage or
 * Network method, so an agent's call never reaches another page, Pane's own window or a cookie.
 */
export const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  'Page.enable',
  'Page.handleJavaScriptDialog',
  'Page.setInterceptFileChooserDialog',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Runtime.evaluate',
  'Runtime.terminateExecution',
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.setFileInputFiles',
  'Emulation.setFocusEmulationEnabled',
]);

/** The parts of a browser tab's WebContents the driver uses (Electron's WebContents fits). */
export interface BrowserPageContents extends DebuggableContents {
  readonly id: number;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  capturePage(): Promise<{ toPNG(): Buffer; getSize(): { width: number; height: number } }>;
  loadURL(url: string): Promise<void>;
  reload(): void;
  navigationHistory: { canGoBack(): boolean; goBack(): void; canGoForward(): boolean; goForward(): void };
  isDevToolsOpened(): boolean;
  /** Set while Pane's docked DevTools (setDevToolsWebContents) inspects the page, which isDevToolsOpened misses. */
  readonly devToolsWebContents: { isDestroyed(): boolean } | null;
  /** Inserts text at the page's focus, whether or not the page has the window's focus. */
  insertText(text: string): Promise<void>;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[], userGesture?: boolean): Promise<unknown>;
  on(event: 'did-stop-loading' | 'did-navigate', listener: () => void): unknown;
  /** Every input event the page gets, the person's and the agent's alike. */
  on(event: 'input-event', listener: (event: unknown, input: { type: string }) => void): unknown;
  removeListener(event: 'did-stop-loading' | 'did-navigate', listener: () => void): unknown;
  debugger: DebuggableContents['debugger'] & {
    sendCommand(method: string, params?: object): Promise<unknown>;
    on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
    on(event: 'detach', listener: () => void): unknown;
  };
}

export interface PendingDialog { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string }
export interface FileChooser { multiple: boolean }

/** What an action leaves for the agent to know: a dialog or file picker it opened. */
export interface ActionOutcome { dialog?: PendingDialog; fileChooser?: FileChooser }

export type ClickTarget = { ref: string } | { x: number; y: number };

/** How long an action waits for its element to become visible, enabled and uncovered. */
const ACTIONABLE_WAIT_MS = 5_000;
/** How long after its input an action looks for a dialog or file picker it opened. */
const SETTLE_MS = 150;
const NAVIGATION_WAIT_MS = 30_000;
export const EVALUATE_TIMEOUT_MS = 30_000;
export const EVALUATE_RESULT_LIMIT = 64 * 1024;
export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 120_000;

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
/** Named keys: [code, windowsVirtualKeyCode, text typed]. */
const NAMED_KEYS: Record<string, [string, number, string?]> = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32, ' '], Space: ['Space', 32, ' '],
};
/** Editing commands a modifier chord runs (Chromium needs them named when input is synthetic). */
const CHORD_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

function stale(reason: string): PaneError {
  return new PaneError('ERR_BROWSER_STALE_REF', `${reason} Nothing ran.`, 'Call browser_snapshot for fresh refs, then try again with one of them.');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drives one browser tab's page for agents. It is the only module that sends debugger commands,
 * and it sends only ALLOWED_CDP_METHODS, attached through attachDebugger. Reading the page and
 * resolving refs runs in an isolated world (pageScript.ts); input goes through the debugger as
 * real mouse and key events, aimed at this page only, so it never lands in Pane's own window.
 */
export class PageDriver {
  private dialog: PendingDialog | undefined;
  private chooser: (FileChooser & { backendNodeId: number }) | undefined;
  private listening = false;
  private refsRevoked = false;
  private dispatching = 0;
  private lastDispatchEnd = 0;
  private screenshots: Promise<unknown> = Promise.resolve();
  private readonly dialogWaiters = new Set<() => void>();

  constructor(private readonly contents: BrowserPageContents) {}

  get pendingDialog(): PendingDialog | undefined {
    return this.dialog;
  }

  /** Whether input the page sees now came from the agent (so it never reads as the person's). */
  isAgentInput(now = Date.now()): boolean {
    return this.dispatching > 0 || now - this.lastDispatchEnd < SETTLE_MS * 2;
  }

  /** Refs from before now stop working until the next snapshot (the person took over). */
  revokeRefs(): void {
    this.refsRevoked = true;
  }

  async snapshot(): Promise<{ url: string; title: string; snapshot: string; truncated: boolean }> {
    this.refuseWhileDialog();
    const result = await this.page('snapshot');
    if (!isObject(result) || typeof result.snapshot !== 'string') throw new PaneError('ERR_BROWSER_PAGE_FAILED', 'The page did not return a snapshot.', 'Try again; if the page is still loading, call browser_wait first.');
    this.refsRevoked = false;
    return { url: String(result.url ?? this.contents.getURL()), title: String(result.title ?? this.contents.getTitle()), snapshot: result.snapshot, truncated: result.truncated === true };
  }

  /** A PNG of what the tab shows, or of the whole page. One capture per tab at a time. */
  screenshot(fullPage: boolean): Promise<{ png: Buffer; width: number; height: number }> {
    const run = this.screenshots.then(async () => {
      if (!fullPage) {
        const image = await this.contents.capturePage();
        const size = image.getSize();
        return { png: image.toPNG(), width: size.width, height: size.height };
      }
      await this.attach();
      const metrics = await this.send('Page.getLayoutMetrics');
      const content = isObject(metrics) && isObject(metrics.cssContentSize) ? metrics.cssContentSize : undefined;
      const width = Math.ceil(Number(content?.width ?? 0));
      const height = Math.min(Math.ceil(Number(content?.height ?? 0)), 16_384);
      const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      if (!isObject(shot) || typeof shot.data !== 'string') throw new PaneError('ERR_BROWSER_PAGE_FAILED', 'The page did not return a screenshot.', 'Try again without --full-page.');
      return { png: Buffer.from(shot.data, 'base64'), width, height };
    });
    this.screenshots = run.catch(() => undefined);
    return run;
  }

  async click(target: ClickTarget, button: 'left' | 'right' | 'middle', double: boolean): Promise<ActionOutcome & { x: number; y: number }> {
    this.refuseWhileDialog();
    const { x, y } = 'ref' in target ? await this.actionablePoint(target.ref) : target;
    const outcome = await this.input(async () => {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      for (let count = 1; count <= (double ? 2 : 1); count += 1) {
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: count });
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: count });
      }
    }, true);
    return { ...outcome, x, y };
  }

  async type(ref: string, text: string, clear: boolean, submit: boolean): Promise<ActionOutcome> {
    this.refuseWhileDialog();
    await this.focus(ref, clear);
    return this.input(async () => {
      if (clear) await this.key('Backspace', 0);
      // Electron's insertText reaches a page without focus; the debugger's drops the text there.
      if (text) await this.contents.insertText(text);
      if (submit) await this.key('Enter', 0);
    }, false);
  }

  async press(chord: string, ref: string | undefined): Promise<ActionOutcome> {
    this.refuseWhileDialog();
    const { key, modifiers } = parseChord(chord);
    if (ref) await this.focus(ref, false);
    return this.input(() => this.key(key, modifiers), true);
  }

  async select(ref: string, values: string[]): Promise<string[]> {
    this.refuseWhileDialog();
    const result = await this.withRef(ref, () => this.page('select', ref, values));
    if (!Array.isArray(result)) throw new PaneError('ERR_BROWSER_PAGE_FAILED', 'The page did not choose the options.', 'Call browser_snapshot and try again.');
    return result.map(String);
  }

  async scroll(ref: string | undefined, dx: number, dy: number): Promise<void> {
    this.refuseWhileDialog();
    if (ref === undefined && (dx !== 0 || dy !== 0)) {
      const center = await this.viewportCenter();
      await this.input(() => this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: dx, deltaY: dy }), false);
      return;
    }
    await this.withRef(ref ?? null, () => this.page('scrollBy', ref ?? null, dx, dy));
  }

  /** Loads a URL (already checked to be http or https), or goes back, forward or reloads; returns once loaded. */
  async navigate(target: { url: string } | { history: 'back' | 'forward' | 'reload' }): Promise<void> {
    this.refuseWhileDialog();
    if ('url' in target) {
      await this.contents.loadURL(target.url).catch((cause: unknown) => {
        // A load that a newer navigation replaced (ERR_ABORTED) still leaves the tab on a page.
        if (cause instanceof Error && /ERR_ABORTED/.test(cause.message)) return;
        throw new PaneError('ERR_BROWSER_NAVIGATION_FAILED', `The page at ${target.url} did not load: ${cause instanceof Error ? cause.message : String(cause)}.`, 'Check the URL, or call browser_snapshot to see what the tab shows.');
      });
      return;
    }
    const history = this.contents.navigationHistory;
    if (target.history === 'back' && !history.canGoBack()) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', 'This tab has no page to go back to. Nothing ran.', 'Use browser_navigate with a URL instead.');
    if (target.history === 'forward' && !history.canGoForward()) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', 'This tab has no page to go forward to. Nothing ran.', 'Use browser_navigate with a URL instead.');
    const loaded = this.nextLoad();
    if (target.history === 'back') history.goBack();
    else if (target.history === 'forward') history.goForward();
    // Electron's own reload: Page.reload on a webview reloads Pane's whole window.
    else this.contents.reload();
    await loaded;
  }

  /** Returns once every condition holds, or fails at the timeout. */
  async wait(conditions: { text?: string; url?: string; ref?: string }, timeoutMs: number): Promise<void> {
    this.refuseWhileDialog();
    if (conditions.ref && this.refsRevoked) throw stale('The person took over this tab, so refs from before are revoked.');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = this.contents.isLoading() ? undefined : await this.page('check', conditions.text ?? null, conditions.url ?? null, conditions.ref ?? null).catch(() => undefined);
      if (isObject(result) && typeof result.stale === 'string') throw stale(result.stale);
      if (isObject(result) && result.met === true) return;
      if (this.dialog) return;
      if (Date.now() >= deadline) {
        const wanted = [conditions.text && `text "${conditions.text}"`, conditions.url && `a URL containing "${conditions.url}"`, conditions.ref && `${conditions.ref} visible`].filter(Boolean).join(' and ');
        throw new PaneError('ERR_BROWSER_WAIT_TIMEOUT', `The page did not show ${wanted} within ${Number((timeoutMs / 1000).toFixed(1))} seconds.`, 'Call browser_snapshot to see what the page shows, or wait longer with --timeout-ms.');
      }
      await sleep(200);
    }
  }

  async answerDialog(accept: boolean, text: string | undefined): Promise<PendingDialog> {
    const dialog = this.dialog;
    if (!dialog) throw new PaneError('ERR_BROWSER_NO_DIALOG', 'This tab has no dialog open. Nothing ran.', 'Call browser_tabs to see which tab has one.');
    await this.attach();
    const params: { accept: boolean; promptText?: string } = { accept };
    if (text !== undefined) params.promptText = text;
    await this.send('Page.handleJavaScriptDialog', params);
    this.dialog = undefined;
    return dialog;
  }

  /** Runs an expression in the page (or a function of a ref's element); the value as JSON, capped. */
  async evaluate(expression: string, ref: string | undefined): Promise<{ value: unknown; truncated: boolean }> {
    this.refuseWhileDialog();
    let source = expression;
    if (ref) {
      const token = `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await this.withRef(ref, () => this.page('mark', ref, 'data-pane-evaluate', token));
      source = `(() => { const el = document.querySelector('[data-pane-evaluate="${token}"]'); el?.removeAttribute('data-pane-evaluate'); return (${expression})(el); })()`;
    }
    await this.attach();
    // A script stopped at its timeout makes Chromium answer with a bare "Internal error".
    const started = Date.now();
    const evaluated = this.send('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true, userGesture: true, timeout: EVALUATE_TIMEOUT_MS })
      .catch((cause: unknown) => {
        if (cause instanceof PaneError) throw cause;
        if (Date.now() - started >= EVALUATE_TIMEOUT_MS - 1_000) throw evaluateTimeout();
        throw new PaneError('ERR_BROWSER_EVALUATE_FAILED', `The page could not run the script: ${cause instanceof Error ? cause.message : String(cause)}.`, 'Check the expression and try again.');
      });
    let timer: NodeJS.Timeout | undefined;
    const overdue = new Promise<'overdue'>(resolve => { timer = setTimeout(() => resolve('overdue'), EVALUATE_TIMEOUT_MS + 2_000); });
    const result = await Promise.race([evaluated, overdue]).finally(() => clearTimeout(timer));
    if (result === 'overdue') {
      await this.send('Runtime.terminateExecution').catch(() => undefined);
      throw evaluateTimeout();
    }
    if (!isObject(result)) throw new PaneError('ERR_BROWSER_EVALUATE_FAILED', 'The page returned no result.', 'Check the expression and try again.');
    if (isObject(result.exceptionDetails)) {
      const details = result.exceptionDetails;
      const description = isObject(details.exception) && typeof details.exception.description === 'string' ? details.exception.description : String(details.text ?? 'an error');
      if (/terminated|timed out/i.test(description)) throw evaluateTimeout();
      throw new PaneError('ERR_BROWSER_EVALUATE_FAILED', `The script threw: ${description.split('\n')[0]}`, 'Fix the expression and try again.');
    }
    const value = isObject(result.result) ? result.result.value : undefined;
    const json = JSON.stringify(value ?? null);
    if (json.length <= EVALUATE_RESULT_LIMIT) return { value: value ?? null, truncated: false };
    return { value: json.slice(0, EVALUATE_RESULT_LIMIT), truncated: true };
  }

  /** Puts files into a file input by ref, or into the file picker the page opened. Paths are already checked. */
  async upload(ref: string | undefined, paths: string[]): Promise<void> {
    this.refuseWhileDialog();
    if (!ref) {
      const chooser = this.chooser;
      if (!chooser) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', 'No file picker is open in this tab and no ref was given. Nothing ran.', 'Pass the file input\'s ref from browser_snapshot, or click the button that opens the picker first.');
      if (!chooser.multiple && paths.length > 1) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', 'The file picker takes one file. Nothing ran.', 'Pass one path.');
      await this.send('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
      this.chooser = undefined;
      return;
    }
    const token = `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await this.withRef(ref, () => this.page('mark', ref, 'data-pane-upload', token));
    await this.attach();
    const document = await this.send('DOM.getDocument', { depth: 0 });
    const root = isObject(document) && isObject(document.root) ? Number(document.root.nodeId) : NaN;
    const found = await this.send('DOM.querySelector', { nodeId: root, selector: `[data-pane-upload="${token}"]` });
    const nodeId = isObject(found) ? Number(found.nodeId) : 0;
    if (!nodeId) throw stale(`${ref} has left the page.`);
    await this.send('DOM.setFileInputFiles', { files: paths, nodeId });
    await this.page('mark', ref, 'data-pane-upload', '').catch(() => undefined);
  }

  private refuseWhileDialog(): void {
    const dialog = this.dialog;
    if (dialog) {
      throw new PaneError('ERR_BROWSER_DIALOG_PENDING', `The page has a ${dialog.type} dialog open ("${dialog.message.slice(0, 120)}"), and it blocks the page until it is answered. Nothing ran.`, 'Answer it with browser_dialog (accept or dismiss), or ask the person to.');
    }
  }

  /** Runs a call on the page script in Pane's isolated world. */
  private page(method: Parameters<typeof pageCall>[0], ...args: unknown[]): Promise<unknown> {
    return this.contents.executeJavaScriptInIsolatedWorld(PANE_WORLD_ID, [{ code: pageCall(method, ...args) }], false);
  }

  /** Runs a ref call, turning the page's stale and not-yet-actionable answers into errors. */
  private async withRef<Result>(ref: string | null, work: () => Promise<Result>): Promise<Result> {
    if (ref !== null && this.refsRevoked) throw stale('The person took over this tab, so refs from before are revoked.');
    const result = await work();
    if (isObject(result) && typeof result.stale === 'string') throw stale(result.stale);
    if (isObject(result) && typeof result.wait === 'string') throw new PaneError('ERR_BROWSER_NOT_ACTIONABLE', `${result.wait} Nothing ran.`, 'Call browser_snapshot to see the page, scroll, or wait for it with browser_wait.');
    return result;
  }

  /** Waits for the element to be visible, enabled and uncovered, then returns its center. */
  private async actionablePoint(ref: string): Promise<{ x: number; y: number }> {
    const deadline = Date.now() + ACTIONABLE_WAIT_MS;
    for (;;) {
      try {
        const result = await this.withRef(ref, () => this.page('point', ref));
        if (isObject(result) && typeof result.x === 'number' && typeof result.y === 'number') return { x: result.x, y: result.y };
        throw new PaneError('ERR_BROWSER_PAGE_FAILED', 'The page did not say where the element is.', 'Call browser_snapshot and try again.');
      } catch (cause) {
        if (!(cause instanceof PaneError) || cause.code !== 'ERR_BROWSER_NOT_ACTIONABLE' || Date.now() >= deadline) throw cause;
        await sleep(100);
      }
    }
  }

  private async focus(ref: string, clear: boolean): Promise<void> {
    await this.attach();
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.withRef(ref, () => this.page('focus', ref, clear));
  }

  private async viewportCenter(): Promise<{ x: number; y: number }> {
    await this.attach();
    const metrics = await this.send('Page.getLayoutMetrics');
    const viewport = isObject(metrics) && isObject(metrics.cssLayoutViewport) ? metrics.cssLayoutViewport : {};
    return { x: Number(viewport.clientWidth ?? 800) / 2, y: Number(viewport.clientHeight ?? 600) / 2 };
  }

  /**
   * Sends the agent's input as real input to this page. Focus is emulated while it runs, so a page
   * without focus still takes keys and Pane's window keeps its own. A dialog or file picker the
   * input opens is returned at once: the page stays blocked until browser_dialog answers it.
   */
  private async input(work: () => Promise<unknown>, interceptChooser: boolean): Promise<ActionOutcome> {
    await this.attach();
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    this.chooser = undefined;
    if (interceptChooser) await this.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    this.dispatching += 1;
    const dialogOpened = new Promise<'dialog'>(resolve => { const done = () => resolve('dialog'); this.dialogWaiters.add(done); });
    try {
      const sent = work().then(() => 'sent' as const);
      // An alert blocks the page, so the input's own reply waits for the answer; don't.
      sent.catch(() => undefined);
      if (await Promise.race([sent, dialogOpened]) === 'sent') await Promise.race([sleep(SETTLE_MS), dialogOpened]);
    } finally {
      this.dialogWaiters.clear();
      this.dispatching -= 1;
      this.lastDispatchEnd = Date.now();
      // While a dialog blocks the page this reply waits for the answer, so it is never awaited.
      if (interceptChooser) void this.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
    }
    return this.outcome();
  }

  /** The dialog and file picker the page has open now (event handlers set them while input runs). */
  private outcome(): ActionOutcome {
    const outcome: ActionOutcome = {};
    if (this.dialog) outcome.dialog = this.dialog;
    if (this.chooser) outcome.fileChooser = { multiple: this.chooser.multiple };
    return outcome;
  }

  private async key(key: string, modifiers: number): Promise<void> {
    const named = NAMED_KEYS[key];
    const single = key.length === 1 ? key : undefined;
    if (!named && !single) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', `"${key}" is not a key Pane knows. Nothing ran.`, 'Use a key name such as Enter, Tab, Escape, ArrowDown, or one character, with modifiers joined by + (Shift+Tab, Meta+A).');
    const code = named ? named[0] : /[a-z]/i.test(single ?? '') ? `Key${(single ?? '').toUpperCase()}` : /\d/.test(single ?? '') ? `Digit${single}` : '';
    const keyCode = named ? named[1] : (single ?? '').toUpperCase().charCodeAt(0);
    const chordOnly = (modifiers & ~8) !== 0;
    const text = chordOnly ? undefined : named ? named[2] : single;
    const command = chordOnly && single ? CHORD_COMMANDS[single.toLowerCase()] : undefined;
    const down: Record<string, unknown> = { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    if (text) { down.text = text; down.unmodifiedText = text; }
    if (command) down.commands = [command];
    await this.send('Input.dispatchKeyEvent', down);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  }

  /** Resolves when the page next stops loading. */
  private nextLoad(): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.contents.removeListener('did-stop-loading', done); resolve(); };
      const timer = setTimeout(done, NAVIGATION_WAIT_MS);
      this.contents.on('did-stop-loading', done);
    });
  }

  /** Attaches through attachDebugger (the only way Pane attaches) and listens for dialogs once. */
  private async attach(): Promise<void> {
    if (this.contents.isDestroyed()) throw new PaneError('ERR_BROWSER_NO_TAB', 'The tab\'s page closed while the call ran. Nothing more ran.', 'Call browser_tabs, then try again.');
    attachDebugger(this.contents);
    if (this.listening) return;
    this.listening = true;
    this.contents.debugger.on('detach', () => { this.listening = false; this.dialog = undefined; this.chooser = undefined; });
    this.contents.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.javascriptDialogOpening' && isObject(params)) {
        const type = String(params.type);
        const dialog: PendingDialog = { type: type === 'confirm' || type === 'prompt' || type === 'beforeunload' ? type : 'alert', message: String(params.message ?? '') };
        if (typeof params.defaultPrompt === 'string' && type === 'prompt') dialog.defaultPrompt = params.defaultPrompt;
        this.dialog = dialog;
        for (const waiter of this.dialogWaiters) waiter();
      } else if (method === 'Page.javascriptDialogClosed') {
        this.dialog = undefined;
      } else if (method === 'Page.fileChooserOpened' && isObject(params) && typeof params.backendNodeId === 'number') {
        this.chooser = { backendNodeId: params.backendNodeId, multiple: params.mode === 'selectMultiple' };
      } else if (method === 'Page.frameNavigated' && isObject(params) && isObject(params.frame) && params.frame.parentId === undefined) {
        this.chooser = undefined;
      }
    });
    await this.send('Page.enable');
  }

  /** Every debugger command goes through here; anything outside ALLOWED_CDP_METHODS is refused. */
  private send(method: string, params?: object): Promise<unknown> {
    if (!ALLOWED_CDP_METHODS.has(method)) {
      return Promise.reject(new PaneError('ERR_BROWSER_METHOD_REFUSED', `Pane's page driver does not send ${method}.`, 'This is a bug in Pane; report it.'));
    }
    return this.contents.debugger.sendCommand(method, params);
  }
}

function evaluateTimeout(): PaneError {
  return new PaneError('ERR_BROWSER_EVALUATE_TIMEOUT', `The script was still running after ${EVALUATE_TIMEOUT_MS / 1000} seconds, so Pane stopped it. The page still responds.`, 'Make the script finish sooner, or split the work into smaller calls.');
}

/** "Meta+Shift+A" → the key and CDP's modifier bits. */
function parseChord(chord: string): { key: string; modifiers: number } {
  const parts = chord.split('+');
  // "+" itself, or a chord ending in "+" ("Control++").
  const key = chord.endsWith('++') || chord === '+' ? '+' : parts[parts.length - 1];
  const names = chord === '+' ? [] : parts.slice(0, chord.endsWith('++') ? -2 : -1);
  let modifiers = 0;
  for (const name of names) {
    const bit = MODIFIERS[name.toLowerCase()];
    if (bit === undefined) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', `"${name}" in "${chord}" is not a modifier. Nothing ran.`, 'Use Alt, Control, Meta or Shift, joined by + (Meta+A).');
    modifiers |= bit;
  }
  if (!key) throw new PaneError('ERR_BROWSER_INVALID_REQUEST', `"${chord}" names no key. Nothing ran.`, 'Pass a key such as Enter or Meta+A.');
  return { key, modifiers };
}
