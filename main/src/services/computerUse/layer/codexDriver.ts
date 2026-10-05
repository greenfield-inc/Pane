/**
 * The layer's driver over the Codex runtime's verbs (../codexEngine.ts). The runtime renders and
 * diffs the tree and settles on its own, so this driver is `native`: the layer passes its text
 * through. On macOS the runtime is keyed by app, not window, so each running app stands in as one
 * window.
 */
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineImage, EngineResult } from '../engine';
import type { ActionOutcome, ActionTarget, AppInfo, DesktopDriver, DriverAction, WindowInfo, WindowSnapshot } from './driver';

type CallEngine = (tool: string, args: JsonObject) => Promise<EngineResult>;

const appsSchema = boundary.object({
  apps: boundary.array(boundary.object({
    id: boundary.string,
    displayName: boundary.optional(boundary.string),
    isRunning: boundary.optional(boundary.boolean),
  })),
});
const windowsSchema = boundary.object({
  windows: boundary.array(boundary.object({ id: boundary.number, app: boundary.string, title: boundary.optional(boundary.string) })),
});
const stateSchema = boundary.object({ state: boundary.string });
const noteSchema = boundary.object({ broughtForward: boundary.optional(boundary.boolean) });

/** The runtime's whole answer when nothing changed since its last read. */
const NO_CHANGE = /^There has been no change in the accessibility tree/;

/** Pixels per line when the layer scrolls by lines; Codex scrolls by pages or pixels. */
const PIXELS_PER_LINE = 40;

export function codexDriver(call: CallEngine, platform: DesktopDriver['platform']): DesktopDriver {
  /** macOS: stand-in window ids, one per app, and the bundle id each stands for. */
  const appByWindow = new Map<number, string>();
  const windowByApp = new Map<string, number>();
  /** The runtime keeps its diff baseline across connections, so this driver's first read of a window is full. */
  const readBefore = new Set<number>();
  /**
   * A runtime screenshot also moves its diff baseline, so captures read the state with it and keep
   * the diff here for the agent's next read.
   */
  const unseenDiffs = new Map<number, string[]>();

  function windowFor(appId: string): number {
    let id = windowByApp.get(appId);
    if (id === undefined) {
      id = windowByApp.size + 1;
      windowByApp.set(appId, id);
      appByWindow.set(id, appId);
    }
    return id;
  }

  /**
   * How a verb names its target: the app on macOS, the window elsewhere. `pid` is the stand-in
   * window's own number: the runtime ignores it, and the daemon queues calls and the layer's lane
   * holds by it.
   */
  function targetOf(window: WindowInfo): JsonObject {
    const target: JsonObject = platform === 'mac' ? { app: appByWindow.get(window.id) ?? window.app } : { window_id: window.id };
    target.pid = window.pid;
    return target;
  }

  function pointOf(target: ActionTarget): JsonObject {
    return 'ref' in target ? { element_index: Number(target.ref) } : { x: target.x, y: target.y };
  }

  async function data(tool: string, args: JsonObject) {
    const result = await call(tool, args);
    if (!result.ok) throw new Error(result.error?.message ?? `${tool} failed.`);
    return result;
  }

  async function act(window: WindowInfo, tool: string, args: JsonObject): Promise<ActionOutcome> {
    const callArgs = { ...targetOf(window), ...args };
    // On Windows the runtime brings the window forward for every input; marking the call makes the
    // daemon show the user its foreground notice first.
    if (platform === 'windows') callArgs.delivery_mode = 'foreground';
    const result = await call(tool, callArgs);
    const { notice } = result;
    if (!result.ok) return { ok: false, needsForeground: false, message: result.error?.message ?? `${tool} failed.`, notice };
    return decodeOptionalBoundary(result.data, noteSchema)?.broughtForward ? { ok: true, note: 'the window came to the front for this input', notice } : { ok: true, notice };
  }

  async function listApps(): Promise<AppInfo[]> {
    const { apps } = decodeOptionalBoundary((await data('list_apps', {})).data, appsSchema) ?? { apps: [] };
    return apps.map((app) => ({ id: app.id, displayName: app.displayName, isRunning: app.isRunning === true }));
  }

  const driver: DesktopDriver = {
    platform,
    renders: 'native',

    listApps,


    async listWindows(): Promise<WindowInfo[]> {
      if (platform === 'mac') {
        return (await listApps()).filter((app) => app.isRunning).map((app) => { const id = windowFor(app.id); return { id, pid: id, app: app.displayName ?? app.id }; });
      }
      const { windows } = decodeOptionalBoundary((await data('list_windows', {})).data, windowsSchema) ?? { windows: [] };
      return windows.map((w) => ({ id: w.id, pid: w.id, app: w.app, title: w.title }));
    },

    async launchApp(app: AppInfo): Promise<number | undefined> {
      await data('launch_app', { app: app.id });
      return undefined;
    },

    async readWindow(window, options = {}): Promise<WindowSnapshot> {
      const full = options.full === true || !readBefore.has(window.id);
      const result = await data('get_app_state', { ...targetOf(window), disable_diff: full });
      readBefore.add(window.id);
      const state = decodeOptionalBoundary(result.data, stateSchema)?.state ?? '';
      const earlier = full ? [] : unseenDiffs.get(window.id) ?? [];
      unseenDiffs.delete(window.id);
      const parts = [...earlier, state].filter((part) => !NO_CHANGE.test(part));
      return { elements: [], busy: false, text: parts.length > 0 ? parts.join('\n') : state };
    },

    async captureWindow(window): Promise<EngineImage | undefined> {
      const result = await data('state_and_screenshot', targetOf(window));
      const state = decodeOptionalBoundary(result.data, stateSchema)?.state ?? '';
      if (readBefore.has(window.id) && !NO_CHANGE.test(state)) unseenDiffs.set(window.id, [...(unseenDiffs.get(window.id) ?? []), state]);
      return result.images?.[0];
    },

    perform(window, action: DriverAction): Promise<ActionOutcome> {
      switch (action.kind) {
        case 'click':
          return act(window, 'click', { ...pointOf(action.target), mouse_button: action.button, click_count: action.count });
        case 'scroll':
          return act(window, 'scroll', {
            ...pointOf(action.target),
            direction: action.direction,
            ...(action.by === 'page' ? { pages: action.amount } : { pixels: action.amount * PIXELS_PER_LINE }),
          });
        case 'drag':
          return act(window, 'drag', { from: [action.from.x, action.from.y], to: [action.to.x, action.to.y] });
        case 'typeText':
          return act(window, 'type_text', { text: action.text });
        case 'pressKey':
          return act(window, 'press_key', { key: action.key });
        case 'setValue':
          return act(window, 'set_value', { element_index: Number(action.ref), value: action.value });
        case 'secondaryAction':
          return act(window, 'perform_secondary_action', { element_index: Number(action.ref), action: action.action });
        case 'selectTextMatch':
          return act(window, 'select_text', { element_index: Number(action.ref), text: action.text, prefix: action.prefix, suffix: action.suffix, selection_type: action.selectionType });
        case 'paste':
          return act(window, 'paste', { text: action.text, format: action.format });
        case 'selectText':
          return Promise.resolve({ ok: false, needsForeground: false, message: 'The Codex runtime selects by text; the layer sends selectTextMatch.' });
      }
    },

    // The runtime pastes and restores the clipboard itself, so the layer never needs these.
    async readClipboard() {
      return { restorable: false };
    },
    async writeClipboard() {
      throw new Error('The Codex runtime pastes through its own paste verb.');
    },
  };
  // Only macOS is keyed by app; elsewhere the layer picks a window from listWindows.
  if (platform === 'mac') {
    driver.resolveApp = async (target) => {
      const app = (await listApps()).find((a) => a.id === target || a.displayName?.toLowerCase() === target.toLowerCase());
      const name = app?.displayName ?? target.split('/').pop()?.replace(/\.app$/, '') ?? target;
      const id = windowFor(app?.id ?? target);
      return { window: { id, pid: id, app: name }, name };
    };
  }
  return driver;
}
