import type { DeviceDriver } from './devices';
import type { BrowserPageSize } from './panels';

/**
 * A browser tab's page streamed from its Pane's host to another screen (docs/BROWSER_AGENTS.md):
 * frames read over `browser:frame`, the tab's state over `browser:view`, and the person's input
 * sent back over `browser:input`. Coordinates are the page's CSS pixels.
 */

/** Keyboard modifiers as Chromium counts them: Alt 1, Control 2, Meta 4, Shift 8. */
export type BrowserModifiers = number;

/** One input from the person on another screen, applied to the page in order. */
export type BrowserInput =
  | { kind: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button: 'none' | 'left' | 'middle' | 'right'; clicks: number; modifiers: BrowserModifiers }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { kind: 'touch'; action: 'start' | 'move' | 'end'; x: number; y: number }
  /** One key pressed and released: `key` is a KeyboardEvent key ("a", "Enter", "ArrowLeft"). */
  | { kind: 'key'; key: string; modifiers: BrowserModifiers }
  /** Text typed or pasted, IME and dictation included, at the page's focus. */
  | { kind: 'text'; text: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'history'; go: 'back' | 'forward' | 'reload' }
  /** Answers the dialog the page has open. */
  | { kind: 'dialog'; accept: boolean; text?: string }
  /** Files for the file picker the page opened (base64), from the screen's own picker. */
  | { kind: 'files'; files: Array<{ name: string; data: string }> }
  /** The person cancelled the page's file picker. */
  | { kind: 'files-cancel' };

/** What a batch of input left for the screen to know. */
export interface BrowserInputResult {
  success: boolean;
  error?: string;
  /** The kind of field that has the page's focus after the batch, so a phone opens its keyboard. */
  field?: 'text' | 'password' | null;
  /** Text a copy or cut put on the host's clipboard, for the screen's own clipboard. */
  copied?: string;
}

/** The newest frame of a page (JPEG data URL), numbered; `width` and `height` are the page's CSS size it shows. */
export interface BrowserFrame { seq: number; data: string; width: number; height: number }

/** What `browser:frame` answers: a newer frame, nothing new within the wait, or why there is none. */
export type BrowserFrameAnswer =
  | { frame: BrowserFrame }
  | { unchanged: true; seq: number }
  | { stopped: BrowserStop };

/** Why a tab has no live page to stream. */
export type BrowserStop = 'asleep' | 'gone';

/** The tab as another screen draws it around the stream: its address bar, chip and notices. */
export interface BrowserTabView {
  version: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  driver?: DeviceDriver;
  /** Set while a person's screen on another device controls the page's size. */
  size?: BrowserPageSize;
  /** Where the agent last clicked, and when (ms since epoch). */
  agentCursor?: { x: number; y: number; at: number };
  /** The CSS cursor the page shows under the person's pointer ("pointer" over a link). */
  pointer: string;
  /** The page's open alert, confirm or prompt. */
  dialog?: { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string };
  /** The page opened a file picker for the person. */
  fileChooser?: { multiple: boolean };
  /** Recent downloads that saved on the host, newest last. */
  downloads: Array<{ name: string; at: number; agent?: string }>;
  /** The live page's id on the host, unique across restarts: a new one means the page reloaded there (it slept, or Pane restarted). */
  page?: string;
  /** The host's name, for "on studio-mac". */
  host: string;
  stopped?: BrowserStop;
}
