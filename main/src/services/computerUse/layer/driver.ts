import type { JsonObject, JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineImage } from '../engine';
import type { UiElement } from './tree';

/**
 * What an engine adapter gives the layer. Cua Driver's adapter is `cuaDriverDriver`; the Codex
 * runtime (M3) supplies its own. Everything above this seam is engine-agnostic.
 */
export interface DesktopDriver {
  readonly platform: 'mac' | 'windows' | 'linux';
  listApps(): Promise<AppInfo[]>;
  listWindows(pid?: number): Promise<WindowInfo[]>;
  /** Starts an app without bringing it forward. Resolves with its pid when the engine reports one. */
  launchApp(app: AppInfo): Promise<number | undefined>;
  /** Reads a window's tree and screenshot. Throws `WindowGoneError` when the window no longer exists. */
  readWindow(window: WindowInfo): Promise<WindowSnapshot>;
  perform(window: WindowInfo, action: DriverAction, options: { foreground: boolean }): Promise<ActionOutcome>;
  readClipboard(): Promise<ClipboardContents>;
  writeClipboard(text: string): Promise<void>;
}

export interface AppInfo {
  /** Bundle id, path or other id the engine accepts. */
  id: string;
  displayName?: string;
  /** Where the app is installed, when the engine reports it. */
  path?: string;
  isRunning?: boolean;
  pid?: number;
}

export interface WindowInfo {
  id: number;
  pid: number;
  app: string;
  title?: string;
  /** Higher is closer to the front; undefined when the engine can't tell. */
  zIndex?: number;
  onScreen?: boolean;
}

export interface WindowSnapshot {
  title?: string;
  elements: UiElement[];
  /** The app reports itself busy or loading (a busy element, spinner or progress indicator). */
  busy: boolean;
  screenshot?: EngineImage;
}

export interface Point {
  x: number;
  y: number;
}

/** An element handle from the latest snapshot, or a point in window screenshot pixels. */
export type ActionTarget = { ref: string } | Point;

export type DriverAction =
  | { kind: 'click'; target: ActionTarget; button: 'left' | 'right' | 'middle'; count: number }
  | { kind: 'scroll'; target: ActionTarget; direction: 'up' | 'down' | 'left' | 'right'; amount: number; by: 'page' | 'line' }
  | { kind: 'drag'; from: Point; to: Point }
  | { kind: 'typeText'; text: string }
  /** `key` uses xdotool syntax: `Return`, `ctrl+shift+t`, `super+c`. */
  | { kind: 'pressKey'; key: string }
  | { kind: 'setValue'; ref: string; value: string }
  /** Selects `length` characters from `start` in the element's value; length 0 places the cursor. */
  | { kind: 'selectText'; ref: string; start: number; length: number }
  | { kind: 'secondaryAction'; ref: string; action: string };

/** `notice`: the line the engine host returned after showing the user a foreground notice. */
export type ActionOutcome =
  | { ok: true; note?: string; notice?: string }
  /** `stale`: the engine's handles were replaced by a newer read; reading again and retrying fixes it. */
  | { ok: false; needsForeground: boolean; message: string; stale?: boolean; notice?: string };

export interface ClipboardContents {
  text?: string;
  /** False when the clipboard holds something `writeClipboard` can't put back, such as an image. */
  restorable: boolean;
}

export class WindowGoneError extends Error {}

/** One action an agent took, for the run's screenshots and replay. */
export interface StepRecord {
  index: number;
  action: string;
  args: JsonObject;
  result: JsonValue;
  /** The target window after the action settled, in the engine's image type (PNG on Cua Driver, JPEG on Codex). */
  screenshot?: EngineImage;
  at: string;
}
