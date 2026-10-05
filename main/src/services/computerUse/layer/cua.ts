/**
 * The `cua` object agent scripts use: Codex's `cua.getApp()` and app-bound verbs, over any engine
 * behind a `DesktopDriver`. It adds stable element ids and diffs, settling after each action,
 * honest background refusals with an opt-in foreground retry, and a screenshot per step.
 */
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineImage } from '../engine';
import {
  WindowGoneError,
  type ActionOutcome,
  type ActionTarget,
  type AppInfo,
  type DesktopDriver,
  type DriverAction,
  type Point,
  type StepRecord,
  type WindowInfo,
  type WindowSnapshot,
} from './driver';
import { WindowTree } from './tree';

export interface LayerHost {
  driver: DesktopDriver;
  /** Adds text to the script's result. */
  write(text: string): void;
  /** Adds an image to the script's result. */
  emitImage(image: EngineImage): void;
  /** Persists one step; absent where nothing records runs. */
  recordStep?(step: StepRecord): void;
  /**
   * Keeps other agents' engine calls off app `pid` (and the clipboard) while `run` makes its calls,
   * so one action's several calls never interleave with theirs. Absent where nothing else shares the engine.
   */
  holdLanes?<T>(lanes: { pid?: number; clipboard?: boolean }, run: () => Promise<T>): Promise<T>;
  /** Wait after each action before reading again. */
  settleMs?: number;
  /** Longest extra wait while the app reports busy or loading. */
  busyTimeoutMs?: number;
  busyPollMs?: number;
  launchTimeoutMs?: number;
}

type Vec2 = [x: number, y: number];
type Direction = 'up' | 'down' | 'left' | 'right' | 'u' | 'd' | 'l' | 'r';
type MouseButton = 'left' | 'right' | 'middle' | 'l' | 'r' | 'm';
interface ForegroundOption { foreground?: boolean }
interface ObservationOptions { emit?: boolean }
interface StateOptions extends ObservationOptions { disableDiffing?: boolean; disableDiff?: boolean }

const DEFAULT_SETTLE_MS = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_BUSY_POLL_MS = 250;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
/** Paste can't see when the app has read the clipboard, so it waits this long before restoring it. */
const PASTE_RESTORE_DELAY_MS = 500;
const PIXELS_PER_SCROLL_LINE = 40;

/** How each verb reads in the needs_foreground copy: "<App> can't receive <noun> in the background". */
const ACTION_NOUNS = {
  click: 'clicks',
  scroll: 'scrolling',
  drag: 'drags',
  typeText: 'typing',
  pressKey: 'key presses',
  paste: 'pastes',
  setValue: 'value changes',
  selectText: 'text selection',
  performSecondaryAction: 'that action',
};
type Verb = keyof typeof ACTION_NOUNS;

function needsForegroundMessage(app: string, verb: Verb): string {
  return `needs_foreground: ${app} can't receive ${ACTION_NOUNS[verb]} in the background on this OS. Retry with { foreground: true } to bring it to the front; the user will see a notice first.`;
}

export class App {
  private window: WindowInfo;
  /** Foreground notice lines the engine host returned during the current action. */
  private readonly notices = new Set<string>();

  constructor(private readonly layer: Layer, window: WindowInfo, readonly name: string) {
    this.window = window;
  }

  get windowId(): number {
    return this.window.id;
  }

  get pid(): number {
    return this.window.pid;
  }

  // --- Observation

  async getAXState(options: StateOptions = {}): Promise<string> {
    return (await this.observe(options, false)).state;
  }

  async getScreenshot(options: ObservationOptions = {}): Promise<EngineImage> {
    const snapshot = this.native ? { screenshot: await this.capture() } : await this.read({ wait: true });
    if (!snapshot.screenshot) throw new Error(`${this.name} returned no screenshot. Screen Recording may be off for the engine.`);
    if (options.emit !== false) this.layer.host.emitImage(snapshot.screenshot);
    return snapshot.screenshot;
  }

  getAXStateAndScreenshot(options: StateOptions = {}): Promise<{ state: string; screenshot?: EngineImage }> {
    return this.observe(options, true);
  }

  // --- Actions

  click(target: number | Vec2, options: ForegroundOption & { mouseButton?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const button = normalizeButton(options.mouseButton);
    const count = options.clickCount ?? 1;
    return this.act('click', { target: targetArg(target), button, clickCount: count }, options, () =>
      this.perform({ kind: 'click', target: this.resolveTarget(target), button, count }, options),
    );
  }

  scroll(target: number | Vec2, direction: Direction, distance?: number | { pixels: number }, options: ForegroundOption = {}): Promise<void> {
    const dir = normalizeDirection(direction);
    const pixels = decodeOptionalBoundary(distance, pixelsSchema)?.pixels;
    const pages = decodeOptionalBoundary(distance, boundary.number) ?? 1;
    const amount = Math.max(1, Math.round(pixels === undefined ? pages : pixels / PIXELS_PER_SCROLL_LINE));
    const args: JsonObject = { target: targetArg(target), direction: dir };
    if (pixels === undefined) args.pages = amount;
    else args.pixels = pixels;
    return this.act('scroll', args, options, () =>
      this.perform({ kind: 'scroll', target: this.resolveTarget(target), direction: dir, amount, by: pixels === undefined ? 'page' : 'line' }, options),
    );
  }

  drag(from: Vec2, to: Vec2, options: ForegroundOption = {}): Promise<void> {
    return this.act('drag', { from: targetArg(from), to: targetArg(to) }, options, () =>
      this.perform({ kind: 'drag', from: toPoint(from), to: toPoint(to) }, options),
    );
  }

  /** Types into the focused element. Each `\n` presses Return. */
  typeText(text: string, options: ForegroundOption = {}): Promise<void> {
    return this.act('typeText', { text }, options, () => this.typeLines(String(text), options));
  }

  pressKey(key: string, options: ForegroundOption = {}): Promise<void> {
    return this.act('pressKey', { key }, options, () => this.perform({ kind: 'pressKey', key: String(key) }, options));
  }

  /** Sets the value directly, so it never needs the app in front; `foreground` is ignored. */
  setValue(elementIndex: number, value: string): Promise<void> {
    return this.act('setValue', { elementIndex, value }, {}, () =>
      this.perform({ kind: 'setValue', ref: this.refFor(elementIndex), value: String(value) }, {}),
    );
  }

  selectText(
    elementIndex: number,
    text: string,
    options: ForegroundOption & { prefix?: string; suffix?: string; selectionType?: 'text' | 'cursor_before' | 'cursor_after' } = {},
  ): Promise<void> {
    const { prefix = '', suffix = '', selectionType = 'text' } = options;
    return this.act('selectText', { elementIndex, text, prefix, suffix, selectionType }, options, async () => {
      const ref = this.refFor(elementIndex);
      if (this.native) return this.perform({ kind: 'selectTextMatch', ref, text: String(text), prefix: String(prefix), suffix: String(suffix), selectionType }, options);
      const value = this.layer.treeFor(this.window.id).valueFor(elementIndex) ?? '';
      const wanted = String(text);
      const at = findText(value, wanted, String(prefix), String(suffix));
      if (at === undefined) return { ok: false, needsForeground: false, message: `Element ${elementIndex} doesn't contain ${JSON.stringify(wanted)}${prefix || suffix ? ' with that prefix and suffix' : ''}.` };
      // Arrow keys move by user-visible character, so offsets count graphemes, not UTF-16 units.
      const before = graphemeCount(value.slice(0, at));
      const size = graphemeCount(wanted);
      const start = selectionType === 'cursor_after' ? before + size : before;
      const length = selectionType === 'text' ? size : 0;
      return this.perform({ kind: 'selectText', ref, start, length }, options);
    });
  }

  performSecondaryAction(elementIndex: number, action: string, options: ForegroundOption = {}): Promise<void> {
    return this.act('performSecondaryAction', { elementIndex, action }, options, () =>
      this.perform({ kind: 'secondaryAction', ref: this.refFor(elementIndex), action: String(action) }, options),
    );
  }

  /** Pastes into the focused element, then puts the user's clipboard back. */
  paste(text: string, options: ForegroundOption & { format?: 'text' | 'md' | 'html' } = {}): Promise<void> {
    const format = options.format ?? 'text';
    return this.act('paste', { text, format }, options, async () => {
      if (this.native) return this.perform({ kind: 'paste', text: String(text), format }, options);
      if (format === 'html') return { ok: false, needsForeground: false, message: "This engine can't paste HTML yet. Paste it as text or md." };
      const saved = await this.layer.driver.readClipboard().catch(() => undefined);
      if (!saved?.restorable) {
        // Pasting would lose what the user copied, so type the text instead.
        const typed = await this.typeLines(String(text), options);
        return typed.ok ? { ok: true, note: "typed instead of pasting, because the user's clipboard couldn't be saved and restored" } : typed;
      }
      await this.layer.driver.writeClipboard(String(text));
      try {
        return await this.perform({ kind: 'pressKey', key: this.layer.driver.platform === 'mac' ? 'super+v' : 'ctrl+v' }, options);
      } finally {
        await sleep(PASTE_RESTORE_DELAY_MS);
        await this.layer.driver.writeClipboard(saved.text ?? '');
      }
    });
  }

  // --- Internals

  private get native(): boolean {
    return this.layer.driver.renders === 'native';
  }

  private async capture(): Promise<EngineImage | undefined> {
    return this.layer.driver.captureWindow?.(this.window);
  }

  private header(snapshot: WindowSnapshot): string {
    const title = snapshot.title ?? this.window.title;
    return `${this.name}${title ? ` · ${JSON.stringify(title)}` : ''} · window ${this.window.id}${snapshot.busy ? ' · still loading' : ''}`;
  }

  private async observe(options: StateOptions, withImage: boolean): Promise<{ state: string; screenshot?: EngineImage }> {
    const full = options.disableDiffing === true || options.disableDiff === true;
    let snapshot: WindowSnapshot;
    let body: string;
    if (this.native) {
      snapshot = await this.readOnce({ full });
      body = snapshot.text ?? '';
      if (withImage) snapshot.screenshot ??= await this.capture();
    } else {
      snapshot = await this.read({ wait: true });
      body = this.layer.treeFor(this.window.id).render({ full });
    }
    const state = `${this.header(snapshot)}\n${body}`;
    if (options.emit !== false) {
      this.layer.host.write(state);
      if (withImage && snapshot.screenshot) this.layer.host.emitImage(snapshot.screenshot);
    }
    return { state, screenshot: withImage ? snapshot.screenshot : undefined };
  }

  private refFor(elementIndex: number): string {
    if (this.native) {
      if (!Number.isInteger(Number(elementIndex))) throw new TypeError(`Element ids are whole numbers, not ${JSON.stringify(elementIndex)}.`);
      return String(Number(elementIndex));
    }
    const tree = this.layer.treeFor(this.window.id);
    const id = Number(elementIndex);
    if (!tree.has(id)) throw new Error(`Element ${elementIndex} isn't in ${this.name}'s window now. Call getAXState() and use an id from it.`);
    const ref = tree.refFor(id);
    if (ref === undefined) throw new Error(`Element ${elementIndex} can't be acted on by id. Act on its point instead, from getScreenshot().`);
    return ref;
  }

  private async typeLines(text: string, options: ForegroundOption): Promise<ActionOutcome> {
    let outcome: ActionOutcome = { ok: true };
    for (const [i, line] of text.split('\n').entries()) {
      if (i > 0) outcome = await this.perform({ kind: 'pressKey', key: 'Return' }, options);
      if (outcome.ok && line) outcome = await this.perform({ kind: 'typeText', text: line }, options);
      if (!outcome.ok) return outcome;
    }
    return outcome;
  }

  private resolveTarget(target: number | Vec2): ActionTarget {
    const parsed = parseTarget(target);
    return 'x' in parsed ? parsed : { ref: this.refFor(parsed.elementIndex) };
  }

  private async perform(action: DriverAction, options: ForegroundOption): Promise<ActionOutcome> {
    const outcome = await this.layer.driver.perform(this.window, action, { foreground: options.foreground === true });
    if (outcome.notice) this.notices.add(outcome.notice);
    return outcome;
  }

  /**
   * Runs one action, then a settle and a step record. Throws the needs_foreground copy or the
   * engine's message when it fails. A foreground action's notice comes from the engine host, which
   * shows it before the call; its line goes in the result once.
   */
  private async act(verb: Verb, args: JsonObject, options: ForegroundOption, run: () => Promise<ActionOutcome>): Promise<void> {
    const at = new Date().toISOString();
    const index = this.layer.nextStep++;
    const stepArgs: JsonObject = { app: this.name, windowId: this.window.id, ...args };
    if (options.foreground) stepArgs.foreground = true;
    let failure: Error | undefined;
    let result: JsonValue = 'ok';
    try {
      const attempt = async () => {
        const first = await run();
        if (first.ok || !first.stale) return first;
        // Another read of this window (by another agent, say) replaced the engine's handles.
        await this.read({ wait: false });
        return run();
      };
      const lanes = { pid: this.window.pid, clipboard: verb === 'paste' };
      const { holdLanes } = this.layer.host;
      this.notices.clear();
      const outcome = holdLanes ? await holdLanes(lanes, attempt) : await attempt();
      for (const notice of this.notices) this.layer.host.write(notice);
      if (outcome.ok) {
        if (outcome.note) result = `ok: ${outcome.note}`;
      } else {
        failure = new Error(outcome.needsForeground ? needsForegroundMessage(this.name, verb) : outcome.message);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (failure) result = failure.message;
    // A failed action changed nothing to wait for; still capture what the window shows.
    const screenshot = await this.settle(!failure).catch(() => undefined);
    this.layer.host.recordStep?.({
      index,
      action: verb,
      args: stepArgs,
      result,
      screenshot,
      at,
    });
    if (failure) throw failure;
  }

  /** Waits for the app to settle after an action and returns the window's screenshot. */
  private async settle(wait: boolean): Promise<EngineImage | undefined> {
    // A native engine waits for the UI itself before its next capture.
    if (this.native) return this.capture();
    if (wait) await sleep(this.layer.settleMs);
    return (await this.read({ wait })).screenshot;
  }

  /**
   * Reads the tree and a screenshot together: the engine keeps one snapshot per window, so a
   * partial read would invalidate either the element handles or the pixel mapping. With `wait`,
   * re-reads up to the busy timeout while the app reports busy or loading.
   */
  private async read({ wait }: { wait: boolean }): Promise<WindowSnapshot> {
    const deadline = Date.now() + this.layer.busyTimeoutMs;
    for (;;) {
      const snapshot = await this.readOnce();
      this.layer.treeFor(this.window.id).update(snapshot.elements);
      if (!wait || !snapshot.busy || Date.now() >= deadline) return snapshot;
      await sleep(this.layer.busyPollMs);
    }
  }

  /** Reads once; when the window closed, follows the app to its main window. */
  private async readOnce(options: { full?: boolean } = {}): Promise<WindowSnapshot> {
    try {
      return await this.layer.driver.readWindow(this.window, options);
    } catch (error) {
      if (!(error instanceof WindowGoneError)) throw error;
      const next = mainWindow(await this.layer.driver.listWindows(this.window.pid));
      if (!next) throw new Error(`${this.name} has no open window now.`);
      this.window = next;
      return this.layer.driver.readWindow(this.window, options);
    }
  }
}


/** State one `cua` object shares with its apps. */
interface Layer {
  host: LayerHost;
  driver: DesktopDriver;
  settleMs: number;
  busyTimeoutMs: number;
  busyPollMs: number;
  nextStep: number;
  treeFor(windowId: number): WindowTree;
}

export function createCua(host: LayerHost) {
  const { driver } = host;
  const launchTimeoutMs = host.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  /** One tree per window, shared by every App bound to it, so ids hold across getApp calls and scripts. */
  const trees = new Map<number, WindowTree>();
  const layer: Layer = {
    host,
    driver,
    settleMs: host.settleMs ?? DEFAULT_SETTLE_MS,
    busyTimeoutMs: host.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    busyPollMs: host.busyPollMs ?? DEFAULT_BUSY_POLL_MS,
    nextStep: 0,
    treeFor(windowId) {
      let tree = trees.get(windowId);
      if (!tree) {
        tree = new WindowTree();
        trees.set(windowId, tree);
      }
      return tree;
    },
  };

  async function waitForWindow(pid: number | undefined, name: string): Promise<WindowInfo | undefined> {
    const deadline = Date.now() + launchTimeoutMs;
    for (;;) {
      const windows = pid !== undefined ? await driver.listWindows(pid) : (await driver.listWindows()).filter((w) => w.app === name);
      const window = mainWindow(windows);
      if (window || Date.now() >= deadline) return window;
      await sleep(layer.busyPollMs);
    }
  }

  async function listApps(options: ObservationOptions = {}): Promise<AppInfo[]> {
    const apps = await driver.listApps();
    if (options.emit !== false) {
      host.write(apps.map((a) => `${a.displayName ?? a.id}${a.displayName && a.displayName !== a.id ? ` (${a.id})` : ''}${a.isRunning ? ' · running' : ''}`).join('\n'));
    }
    return apps;
  }

  async function listWindows(options: ObservationOptions = {}): Promise<Array<{ id: number; app: string; title?: string }>> {
    const windows = (await driver.listWindows()).map(({ id, app, title }) => ({ id, app, title }));
    if (options.emit !== false) host.write(windows.map((w) => `${w.id} ${w.app}${w.title ? ` ${JSON.stringify(w.title)}` : ''}`).join('\n'));
    return windows;
  }

  /** Binds an app by display name, bundle id or path (launching it in the background), or a window by id. */
  async function getApp(target: string | { windowId: number }): Promise<App> {
    let window: WindowInfo | undefined;
    let name: string;
    const windowId = decodeOptionalBoundary(target, windowTargetSchema)?.windowId;
    if (windowId !== undefined) {
      window = (await driver.listWindows()).find((w) => w.id === windowId);
      if (!window) throw new Error(`No open window has id ${windowId}. cua.listWindows() lists them.`);
      name = window.app;
    } else if (driver.resolveApp) {
      ({ window, name } = await driver.resolveApp(decodeBoundary(target, boundary.nonEmptyString)));
    } else {
      const wanted = decodeBoundary(target, boundary.nonEmptyString);
      const apps = await driver.listApps();
      const lower = wanted.toLowerCase();
      const app = apps.find((a) => a.id === wanted || a.path === wanted) ?? apps.find((a) => a.displayName?.toLowerCase() === lower) ?? apps.find((a) => a.id.toLowerCase() === lower);
      if (!app) throw new Error(`No app matches ${JSON.stringify(wanted)}. cua.listApps() lists them.`);
      name = app.displayName ?? app.id;
      let pid = app.isRunning ? app.pid : undefined;
      if (!app.isRunning) pid = (await driver.launchApp(app)) ?? pid;
      window = await waitForWindow(pid, name);
      if (!window) throw new Error(`${name} has no open window.`);
    }
    const app = new App(layer, window, name);
    await app.getAXState();
    return app;
  }

  return {
    /** The object scripts see as `cua`. */
    cua: { getApp, listApps, listWindows, computer: { target: driver.platform } },
    /** Numbers the next run's steps from 0, as each run gets its own replay. */
    beginRun(): void {
      layer.nextStep = 0;
    },
  };
}

/** The window an agent most likely means: on screen, frontmost, titled. */
function mainWindow(windows: WindowInfo[]): WindowInfo | undefined {
  const score = (w: WindowInfo) => [w.onScreen === false ? 0 : 1, w.zIndex ?? -1, w.title ? 1 : 0];
  return [...windows].sort((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return 0;
  })[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pointSchema = boundary.array(boundary.number);
const pixelsSchema = boundary.object({ pixels: boundary.number });
const windowTargetSchema = boundary.object({ windowId: boundary.number });

/** Scripts are untyped: a point must be `[x, y]` in screenshot pixels. */
function toPoint(value: number | Vec2): Point {
  const point = decodeOptionalBoundary(value, pointSchema);
  if (point?.length !== 2) throw new TypeError('Pass a point as [x, y] in screenshot pixels.');
  return { x: point[0], y: point[1] };
}

/** An element id from the tree, or a point. */
function parseTarget(target: number | Vec2): Point | { elementIndex: number } {
  const elementIndex = decodeOptionalBoundary(target, boundary.number);
  return elementIndex === undefined ? toPoint(target) : { elementIndex };
}

function targetArg(target: number | Vec2): JsonValue {
  const parsed = parseTarget(target);
  return 'x' in parsed ? [parsed.x, parsed.y] : parsed.elementIndex;
}

function normalizeButton(button: MouseButton | undefined): 'left' | 'right' | 'middle' {
  if (button === 'r' || button === 'right') return 'right';
  if (button === 'm' || button === 'middle') return 'middle';
  return 'left';
}

type ScrollDirection = 'up' | 'down' | 'left' | 'right';
const DIRECTIONS = new Map<string, ScrollDirection>([
  ['u', 'up'], ['d', 'down'], ['l', 'left'], ['r', 'right'], ['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'],
]);

function normalizeDirection(direction: Direction): ScrollDirection {
  const dir = DIRECTIONS.get(String(direction));
  if (!dir) throw new TypeError(`Scroll direction must be up, down, left or right, not ${JSON.stringify(direction)}.`);
  return dir;
}

/** Where `text` starts in `value`, honoring an optional prefix and suffix around it. */
/** User-visible characters in `text`. */
function graphemeCount(text: string): number {
  return [...new Intl.Segmenter().segment(text)].length;
}

function findText(value: string, text: string, prefix: string, suffix: string): number | undefined {
  const needle = `${prefix}${text}${suffix}`;
  const at = value.indexOf(needle);
  return at === -1 ? undefined : at + prefix.length;
}
