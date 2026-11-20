import type { BrowserFrameAnswer, BrowserInput, BrowserInputResult, BrowserTabView } from '../../../../../../shared/types/browserStream';
import { VIEWER_ID } from '../browserWatch';
import { decodeBoundary, type JsonValue } from '../../../../../../shared/validation/boundaryDecoder';
import { browserFrameAnswerSchema, browserInputResultSchema, browserTabViewSchema } from '../../../../../../shared/validation/browserStreamSchemas';

/**
 * How a screen reaches the host whose browser tab it streams (docs/BROWSER_AGENTS.md). A desktop
 * uses its own `invoke`, which sends `browser:` channels to the host; the PWA and the phone app
 * pass their own connection's.
 */
export interface BrowserStreamClient {
  frame(panelId: string, after: number): Promise<BrowserFrameAnswer>;
  view(panelId: string, after: number): Promise<BrowserTabView>;
  input(panelId: string, batch: BrowserInput[]): Promise<BrowserInputResult>;
  /** The person's pointer passing over the page (hover): a read, so the host keeps no answer for it. */
  pointer(panelId: string, x: number, y: number): Promise<void>;
  driver(panelId: string, who: 'person' | 'agent'): Promise<void>;
}

/** How long each call may take before the screen counts it as failed; the host answers sooner. */
const VIEW_MS = 15_000;
const INPUT_MS = 20_000;
const SHORT_MS = 10_000;

/** Rejects when `work` takes longer than `ms`; a late answer is dropped. */
function within<Value>(work: Promise<Value>, ms: number): Promise<Value> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The host did not answer in time.')), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A host channel call: rejects with the host's error, so an older host's unknown channel shows. */
type Invoke = (channel: string, ...args: Array<string | number | BrowserInput[]>) => Promise<JsonValue>;

export function streamClient(invoke: Invoke): BrowserStreamClient {
  return {
    frame: async (panelId, after) => decodeBoundary(await invoke('browser:frame', panelId, VIEWER_ID, after), browserFrameAnswerSchema),
    view: async (panelId, after) => decodeBoundary(await within(invoke('browser:view', panelId, after), VIEW_MS), browserTabViewSchema),
    input: async (panelId, batch) => decodeBoundary(await within(invoke('browser:input', panelId, VIEWER_ID, batch), INPUT_MS), browserInputResultSchema),
    pointer: async (panelId, x, y) => { await within(invoke('browser:pointer', panelId, VIEWER_ID, x, y), SHORT_MS); },
    driver: async (panelId, who) => { await within(invoke('browser:driver', panelId, who, VIEWER_ID), SHORT_MS); },
  };
}

/** Whether a failed call means the host has no such channel: an older Pane, which streams nothing. */
export function isOlderHost(error: Error): boolean {
  // A host's own answer, and the desktop's connection's rewrite of it ("<host> runs an older Pane…").
  return /ERR_UNKNOWN_CHANNEL|ERR_HOST_OUTDATED|No Pane daemon command registered|No handler registered|runs an older Pane/i.test(error.message);
}
