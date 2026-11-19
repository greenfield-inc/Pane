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
  driver(panelId: string, who: 'person' | 'agent'): Promise<void>;
}

/** A host channel call: rejects with the host's error, so an older host's unknown channel shows. */
type Invoke = (channel: string, ...args: Array<string | number | BrowserInput[]>) => Promise<JsonValue>;

export function streamClient(invoke: Invoke): BrowserStreamClient {
  return {
    frame: async (panelId, after) => decodeBoundary(await invoke('browser:frame', panelId, VIEWER_ID, after), browserFrameAnswerSchema),
    view: async (panelId, after) => decodeBoundary(await invoke('browser:view', panelId, after), browserTabViewSchema),
    input: async (panelId, batch) => decodeBoundary(await invoke('browser:input', panelId, VIEWER_ID, batch), browserInputResultSchema),
    driver: async (panelId, who) => { await invoke('browser:driver', panelId, who, VIEWER_ID); },
  };
}

/** Whether a failed call means the host has no such channel: an older Pane, which streams nothing. */
export function isOlderHost(error: Error): boolean {
  // A host's own answer, and the desktop's connection's rewrite of it ("<host> runs an older Pane…").
  return /ERR_UNKNOWN_CHANNEL|ERR_HOST_OUTDATED|No Pane daemon command registered|runs an older Pane/i.test(error.message);
}
