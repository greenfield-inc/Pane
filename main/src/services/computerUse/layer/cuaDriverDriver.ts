/**
 * The layer's driver over Cua Driver's raw tools (pinned release in ../cuaDriver.ts). Tool names,
 * arguments and result shapes follow cua-driver-rs 0.33.3.
 */
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineResult } from '../engine';
import {
  WindowGoneError,
  type ActionOutcome,
  type ActionTarget,
  type AppInfo,
  type ClipboardContents,
  type DesktopDriver,
  type DriverAction,
  type WindowInfo,
  type WindowSnapshot,
} from './driver';
import type { UiElement } from './tree';

type CallEngine = (tool: string, args: JsonObject) => Promise<EngineResult>;
type Platform = DesktopDriver['platform'];

const optionalString = boundary.optional(boundary.string);
const optionalNumber = boundary.optional(boundary.number);
const optionalBoolean = boundary.optional(boundary.boolean);

const appSchema = boundary.object({
  pid: optionalNumber,
  name: optionalString,
  bundle_id: boundary.optional(boundary.nullable(boundary.string)),
  running: optionalBoolean,
  launch_path: boundary.optional(boundary.nullable(boundary.string)),
});
const appsSchema = boundary.object({ apps: boundary.array(appSchema) });

const windowSchema = boundary.object({
  window_id: boundary.number,
  pid: boundary.number,
  app_name: optionalString,
  title: optionalString,
  z_index: boundary.optional(boundary.nullable(boundary.number)),
  is_on_screen: optionalBoolean,
  minimized: optionalBoolean,
});
const windowsSchema = boundary.object({ windows: boundary.array(windowSchema) });

const elementSchema = boundary.object({
  element_index: optionalNumber,
  element_token: optionalString,
  role: boundary.string,
  label: optionalString,
  value: optionalString,
  actions: boundary.optional(boundary.array(boundary.string)),
  selected: optionalBoolean,
  enabled: optionalBoolean,
  parent_index: optionalNumber,
});
type CuaElement = ReturnType<typeof elementSchema.decode>;
const windowStateSchema = boundary.object({
  degraded: optionalBoolean,
  screenshot_error: boundary.optional(boundary.jsonObject),
  snapshot_id: optionalString,
  window_title: optionalString,
  tree_markdown: optionalString,
  elements: boundary.optional(boundary.array(elementSchema)),
});

const grantsSchema = boundary.object({
  accessibility: optionalBoolean,
  screen_recording: optionalBoolean,
  source: boundary.optional(boundary.object({ attribution: optionalString })),
});

const launchSchema = boundary.object({ pid: boundary.optional(boundary.nullable(boundary.number)) });
const clipboardSchema = boundary.object({
  types: boundary.optional(boundary.array(boundary.string)),
  text: boundary.optional(boundary.nullable(boundary.string)),
});

/** Error payloads: `{ code }`, `{ refusal: { code } }`, plus an optional escalation. */
const errorSchema = boundary.object({
  code: optionalString,
  refusal: boundary.optional(boundary.object({ code: optionalString })),
  escalation: boundary.optional(boundary.object({ recommended: optionalString })),
});
const successSchema = boundary.object({ effect: optionalString });

/** Refusals that a foreground retry fixes. */
const FOREGROUND_CODES = new Set(['background_unavailable', 'off_space_or_ax_unresolved', 'background_occluded']);
/** The window's snapshot was replaced, or lacks the screenshot mapping a pixel action needs. */
const STALE_CODES = new Set(['stale_element_token', 'screenshot_context_missing']);
const WINDOW_GONE_CODES = new Set(['window_id_not_found', 'window_not_found']);

interface SecondaryAction {
  /** How the tree shows it, and how scripts name it. */
  name: string;
  /** Cua's `click` action that runs it. */
  action: string;
}

/** Secondary actions Cua can run, keyed by the AX or UIA name its tree lists. */
const SECONDARY_ACTIONS = {
  mac: new Map<string, SecondaryAction>([
    ['AXShowMenu', { name: 'Show Menu', action: 'show_menu' }],
    ['AXPick', { name: 'Pick', action: 'pick' }],
    ['AXConfirm', { name: 'Confirm', action: 'confirm' }],
    ['AXCancel', { name: 'Cancel', action: 'cancel' }],
    ['AXOpen', { name: 'Open', action: 'open' }],
  ]),
  windows: new Map<string, SecondaryAction>([['expand', { name: 'Expand', action: 'expand' }]]),
  linux: new Map<string, SecondaryAction>(),
} satisfies Record<Platform, ReadonlyMap<string, SecondaryAction>>;

/** Most selectText moves Cua can make by arrow keys before giving up. */
const MAX_SELECT_KEY_PRESSES = 2_000;

export function cuaDriverDriver(call: CallEngine, platform: Platform = currentPlatform()): DesktopDriver {
  const secondary = SECONDARY_ACTIONS[platform];
  const actionByName = new Map([...secondary.values()].map(({ name, action }) => [name.toLowerCase(), action]));

  async function data(tool: string, args: JsonObject): Promise<JsonValue | undefined> {
    const result = await call(tool, args);
    if (!result.ok) throw new Error(result.error?.message ?? `${tool} failed.`);
    return result.data;
  }

  function outcome(result: EngineResult): ActionOutcome {
    const { notice } = result;
    if (result.ok) {
      const effect = decodeOptionalBoundary(result.data, successSchema)?.effect;
      const note = effect === 'suspected_noop' || effect === 'unverifiable' ? `effect ${effect.replace('_', ' ')}` : undefined;
      return { ok: true, note, notice };
    }
    const payload = decodeOptionalBoundary(result.data, errorSchema);
    const code = payload?.code ?? payload?.refusal?.code ?? result.error?.code ?? '';
    const needsForeground = FOREGROUND_CODES.has(code) || payload?.escalation?.recommended === 'foreground';
    return { ok: false, needsForeground, message: result.error?.message ?? code, stale: STALE_CODES.has(code), notice };
  }

  function targetArgs(window: WindowInfo, target: ActionTarget): JsonObject {
    return 'ref' in target ? { element_token: target.ref } : { window_id: window.id, x: target.x, y: target.y };
  }

  function delivery(window: WindowInfo, foreground: boolean): JsonObject {
    return foreground ? { delivery_mode: 'foreground', window_id: window.id } : {};
  }

  async function key(window: WindowInfo, combo: string, foreground: boolean): Promise<ActionOutcome> {
    const { key: name, modifiers } = parseKey(combo, platform);
    const args: JsonObject = { pid: window.pid, ...delivery(window, foreground), key: name };
    if (modifiers.length > 0) args.modifiers = modifiers;
    return outcome(await call('press_key', args));
  }

  return {
    platform,

    async listApps(): Promise<AppInfo[]> {
      const { apps } = decodeOptionalBoundary(await data('list_apps', {}), appsSchema) ?? { apps: [] };
      return apps.map((app) => ({
        id: app.bundle_id || app.launch_path || app.name || String(app.pid),
        displayName: app.name || undefined,
        path: app.launch_path || undefined,
        isRunning: app.running === true,
        pid: app.running ? app.pid || undefined : undefined,
      }));
    },

    async listWindows(pid?: number): Promise<WindowInfo[]> {
      const { windows } = decodeOptionalBoundary(await data('list_windows', pid === undefined ? {} : { pid }), windowsSchema) ?? { windows: [] };
      return windows.map((w) => ({
        id: w.window_id,
        pid: w.pid,
        app: w.app_name ?? String(w.pid),
        title: w.title || undefined,
        zIndex: w.z_index ?? undefined,
        onScreen: w.is_on_screen !== false && w.minimized !== true,
      }));
    },

    async launchApp(app: AppInfo): Promise<number | undefined> {
      const args: JsonObject =
        platform === 'linux'
          ? { launch_path: app.path ?? app.id }
          : app.id.includes('.') || platform === 'windows'
            ? { bundle_id: app.id }
            : { name: app.displayName ?? app.id };
      const launched = decodeOptionalBoundary(await data('launch_app', args), launchSchema);
      return launched?.pid ?? undefined;
    },

    async readWindow(window): Promise<WindowSnapshot> {
      const result = await call('get_window_state', { pid: window.pid, window_id: window.id });
      if (!result.ok) {
        const payload = decodeOptionalBoundary(result.data, errorSchema);
        if (WINDOW_GONE_CODES.has(payload?.code ?? result.error?.code ?? '')) throw new WindowGoneError(result.error?.message);
        throw new Error(result.error?.message ?? 'Reading the window failed.');
      }
      const state = decodeOptionalBoundary(result.data, windowStateSchema) ?? { degraded: undefined, screenshot_error: undefined, tree_markdown: undefined, elements: undefined, window_title: undefined };
      const elements = toUiElements(state.tree_markdown ?? '', state.elements ?? [], secondary);
      // Without its macOS grants Cua returns an empty, degraded tree that looks like an empty window.
      if (elements.length === 0 && (state.degraded || state.screenshot_error)) await refuseWithoutPermissions();
      return {
        title: state.window_title || undefined,
        elements,
        busy: elements.some(isBusy),
        screenshot: result.images?.[0],
      };
    },

    async perform(window, action: DriverAction, { foreground }): Promise<ActionOutcome> {
      const base = { pid: window.pid, ...delivery(window, foreground) };
      switch (action.kind) {
        case 'click': {
          if ('ref' in action.target && action.count === 2) return outcome(await call('double_click', { ...base, element_token: action.target.ref }));
          if ('ref' in action.target && action.count > 2) return { ok: false, needsForeground: false, message: 'Cua Driver clicks an element at most twice. Click its point for more.' };
          const count: JsonObject = action.count === 1 ? {} : { count: action.count };
          return outcome(await call('click', { ...base, ...targetArgs(window, action.target), button: action.button, ...count }));
        }
        case 'scroll':
          return outcome(await call('scroll', { ...base, ...targetArgs(window, action.target), direction: action.direction, amount: Math.min(50, action.amount), by: action.by }));
        case 'drag':
          return outcome(await call('drag', { ...base, window_id: window.id, from_x: action.from.x, from_y: action.from.y, to_x: action.to.x, to_y: action.to.y }));
        case 'typeText':
          return outcome(await call('type_text', { ...base, window_id: window.id, text: action.text }));
        case 'pressKey':
          return key(window, action.key, foreground);
        case 'setValue':
          return outcome(await call('set_value', { pid: window.pid, element_token: action.ref, value: action.value }));
        case 'secondaryAction': {
          const cuaAction = actionByName.get(action.action.trim().toLowerCase());
          if (!cuaAction) {
            const names = [...secondary.values()].map((a) => a.name);
            return { ok: false, needsForeground: false, message: `Cua Driver can't run "${action.action}". It runs ${names.length ? names.join(', ') : 'no secondary actions'} on this OS.` };
          }
          return outcome(await call('click', { ...base, element_token: action.ref, action: cuaAction }));
        }
        case 'selectText':
          return selectByKeys(window, action, foreground);
      }
    },

    async readClipboard(): Promise<ClipboardContents> {
      const clip = decodeOptionalBoundary(await data('clipboard_read', { include_text: true }), clipboardSchema) ?? { types: undefined, text: undefined };
      const types = clip.types ?? [];
      // Cua writes back plain text only, so anything richer would be lost.
      const restorable = types.every((type) => /text|string|utf/i.test(type) && !/rtf|html/i.test(type));
      return { text: clip.text ?? undefined, restorable };
    },

    async writeClipboard(text: string): Promise<void> {
      await data('clipboard_write', { text });
    },
  };

  /** Throws the user-facing refusal when Cua reports a missing macOS grant for itself. */
  async function refuseWithoutPermissions(): Promise<void> {
    const check = await call('check_permissions', { prompt: false });
    const grants = check.ok ? decodeOptionalBoundary(check.data, grantsSchema) : undefined;
    // Only the helper running as CuaDriver.app answers for its own grants.
    if (grants?.source?.attribution !== 'driver-daemon') return;
    const missing = [...(grants.accessibility === false ? ['Accessibility'] : []), ...(grants.screen_recording === false ? ['Screen Recording'] : [])];
    if (missing.length === 0) return;
    throw new Error(`Computer use needs permission on this machine: ${missing.join(' and ')}. Ask the user to grant it (Settings → Remote Access).`);
  }

  /**
   * Cua can't set a selection range, so this focuses the field, moves to its start, and walks there
   * with arrow keys (shift held for the selected part).
   */
  async function selectByKeys(window: WindowInfo, action: Extract<DriverAction, { kind: 'selectText' }>, foreground: boolean): Promise<ActionOutcome> {
    if (action.start + action.length > MAX_SELECT_KEY_PRESSES) {
      return { ok: false, needsForeground: false, message: `That text is too far into the field to select with Cua Driver (over ${MAX_SELECT_KEY_PRESSES} characters). Use setValue, or click near it first.` };
    }
    const steps: string[] = [platform === 'mac' ? 'super+Up' : 'ctrl+Home', ...Array(action.start).fill('Right'), ...Array(action.length).fill('shift+Right')];
    let result = outcome(await call('click', { pid: window.pid, ...delivery(window, foreground), element_token: action.ref }));
    for (const combo of steps) {
      if (!result.ok) return result;
      result = await key(window, combo, foreground);
    }
    return result.ok ? { ok: true } : result;
  }
}

function currentPlatform(): Platform {
  if (process.platform === 'darwin') return 'mac';
  return process.platform === 'win32' ? 'windows' : 'linux';
}

/**
 * Splits Cua's markdown into rows. Cua writes titles and values unescaped, so a multi-line value
 * continues on lines that can look like rows; a row with an unclosed quote takes the next line.
 */
function markdownRows(markdown: string): string[] {
  const rows: string[] = [];
  for (const line of markdown.split('\n')) {
    const last = rows.length - 1;
    if (last >= 0 && (rows[last].split('"').length - 1) % 2 === 1) rows[last] += `\n${line}`;
    else rows.push(line);
  }
  return rows;
}

/** Merges Cua's markdown tree (every row, with structure) and its structured elements (exact fields). */
function toUiElements(markdown: string, cuaElements: CuaElement[], secondary: ReadonlyMap<string, SecondaryAction>): UiElement[] {
  const byIndex = new Map(cuaElements.flatMap((e) => (e.element_index === undefined ? [] : [[e.element_index, e] as const])));
  const elements: UiElement[] = [];
  const stack: Array<{ depth: number; at: number }> = [];
  for (const line of markdownRows(markdown)) {
    const match = /^( *)- (?:\[(\d+)\] )?([\s\S]*)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 2;
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].at : null;
    const indexed = match[2] === undefined ? undefined : byIndex.get(Number(match[2]));
    const element = indexed ? fromCuaElement(indexed, parent, secondary) : fromDisplayRow(match[3], parent);
    stack.push({ depth, at: elements.length });
    elements.push(element);
  }
  if (elements.length > 0 || cuaElements.length === 0) return elements;

  // No markdown to read: build the tree from the structured rows alone.
  const at = new Map<number, number>();
  return cuaElements.map((e, i) => {
    if (e.element_index !== undefined) at.set(e.element_index, i);
    return fromCuaElement(e, e.parent_index === undefined ? null : at.get(e.parent_index) ?? null, secondary);
  });
}

function fromCuaElement(e: CuaElement, parent: number | null, secondary: ReadonlyMap<string, SecondaryAction>): UiElement {
  const states = [...(e.selected ? ['selected'] : []), ...(e.enabled === false ? ['disabled'] : [])];
  return {
    ref: e.element_token,
    role: normalizeRole(e.role),
    label: e.label || undefined,
    value: e.value,
    actions: (e.actions ?? []).flatMap((a) => secondary.get(a)?.name ?? []),
    states,
    parent,
  };
}

/** A row with no index: `AXStaticText "Saved" = "value" (description)`. */
function fromDisplayRow(text: string, parent: number | null): UiElement {
  const role = /^\S+/.exec(text)?.[0] ?? '';
  let rest = text.slice(role.length).trim();
  let value: string | undefined;
  let description: string | undefined;
  const descriptionMatch = / ?\(([^()]*)\)$/.exec(rest);
  if (descriptionMatch) {
    description = descriptionMatch[1];
    rest = rest.slice(0, descriptionMatch.index).trim();
  }
  const valueMatch = /(?:^| )= "([\s\S]*)"$/.exec(rest);
  if (valueMatch) {
    value = valueMatch[1];
    rest = rest.slice(0, valueMatch.index).trim();
  }
  const label = /^"([\s\S]*)"$/.exec(rest)?.[1] || description;
  return { role: normalizeRole(role), label: label || undefined, value, actions: [], states: [], parent };
}

/** `AXStaticText` → `staticText`, UIA `Button` → `button`; AT-SPI names stay as they are. */
function normalizeRole(role: string): string {
  const bare = role.replace(/^AX/, '');
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

/** A spinner, or a progress indicator with no value (indeterminate), means the app is loading. */
function isBusy(element: UiElement): boolean {
  if (/busyIndicator/i.test(element.role)) return true;
  return /progress ?(indicator|bar)/i.test(element.role) && (element.value === undefined || element.value === '');
}

const MODIFIERS = new Map(Object.entries({
  ctrl: 'ctrl', control: 'ctrl', control_l: 'ctrl', control_r: 'ctrl',
  shift: 'shift', shift_l: 'shift', shift_r: 'shift',
  alt: 'alt', alt_l: 'alt', alt_r: 'alt', option: 'alt',
  super: 'cmd', super_l: 'cmd', super_r: 'cmd', cmd: 'cmd', command: 'cmd', meta: 'cmd', meta_l: 'cmd', meta_r: 'cmd', win: 'cmd',
}));

const KEYS = new Map(Object.entries({
  return: 'return', enter: 'return', kp_enter: 'return', escape: 'escape', esc: 'escape', backspace: 'backspace',
  tab: 'tab', iso_left_tab: 'tab', space: 'space', home: 'home', end: 'end', up: 'up', down: 'down', left: 'left', right: 'right',
  page_up: 'pageup', prior: 'pageup', pageup: 'pageup', page_down: 'pagedown', next: 'pagedown', pagedown: 'pagedown',
  plus: '+', minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', apostrophe: "'",
  bracketleft: '[', bracketright: ']', grave: '`',
}));

/** Parses an xdotool chord (`ctrl+shift+t`, `Return`, `super+c`) into Cua's key and modifier names. */
export function parseKey(combo: string, platform: Platform) {
  const trimmed = combo.trim();
  const parts = trimmed.split('+').map((part) => part.trim()).filter(Boolean);
  // A trailing "+" names the plus key itself: `+`, `ctrl++`.
  if (trimmed === '+' || trimmed.endsWith('++')) parts.push('+');
  const last = parts.pop();
  if (!last) throw new TypeError(`pressKey needs a key, not ${JSON.stringify(combo)}.`);
  const modifiers = parts.map((part) => {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (!modifier) throw new TypeError(`Unknown modifier ${JSON.stringify(part)} in ${JSON.stringify(combo)}. Use ctrl, shift, alt or super.`);
    return modifier === 'alt' && platform === 'mac' ? 'option' : modifier;
  });
  const lower = last.toLowerCase();
  // xdotool's Delete is forward delete; macOS Cua calls that forward_delete.
  const key = KEYS.get(lower) ?? (lower === 'delete' && platform === 'mac' ? 'forward_delete' : lower);
  // `A` alone means shift+a; with other modifiers (`ctrl+T`) it means the plain letter.
  if (last.length === 1 && last !== lower && modifiers.length === 0) modifiers.push('shift');
  return { key, modifiers: [...new Set(modifiers)] };
}
