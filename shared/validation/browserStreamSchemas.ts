import { boundary, type BoundarySchema } from './boundaryDecoder';
import type { BrowserFrameAnswer, BrowserInputResult, BrowserTabView } from '../types/browserStream';

/** What a screen reads back from a host streaming a browser tab (shared/types/browserStream.ts). */

const stopSchema = boundary.enumeration('asleep', 'gone');
const fieldSchema = boundary.optional(boundary.nullable(boundary.enumeration('text', 'password')));

export const browserFrameAnswerSchema: BoundarySchema<BrowserFrameAnswer> = boundary.union(
  boundary.object({ frame: boundary.object({ seq: boundary.number, data: boundary.string, width: boundary.number, height: boundary.number }) }),
  boundary.object({ unchanged: boundary.literal(true), seq: boundary.number }),
  boundary.object({ stopped: stopSchema }),
);

export const browserInputResultSchema: BoundarySchema<BrowserInputResult> = boundary.object({
  field: fieldSchema,
  copied: boundary.optional(boundary.string),
});

const driverSchema = boundary.union(
  boundary.object({ by: boundary.literal('agent'), agent: boundary.string }),
  boundary.object({ by: boundary.literal('person'), agentWaiting: boundary.optional(boundary.string) }),
);

export const browserTabViewSchema: BoundarySchema<BrowserTabView> = boundary.object({
  version: boundary.number,
  url: boundary.string,
  title: boundary.string,
  loading: boundary.boolean,
  canGoBack: boundary.boolean,
  canGoForward: boundary.boolean,
  driver: boundary.optional(driverSchema),
  size: boundary.optional(boundary.object({ width: boundary.number, height: boundary.number, mobile: boundary.boolean })),
  agentCursor: boundary.optional(boundary.object({ x: boundary.number, y: boundary.number, at: boundary.number })),
  pointer: boundary.string,
  dialog: boundary.optional(boundary.object({ type: boundary.enumeration('alert', 'confirm', 'prompt', 'beforeunload'), message: boundary.string, defaultPrompt: boundary.optional(boundary.string) })),
  fileChooser: boundary.optional(boundary.object({ multiple: boundary.boolean })),
  downloads: boundary.array(boundary.object({ name: boundary.string, at: boundary.number, agent: boundary.optional(boundary.string) })),
  page: boundary.optional(boundary.string),
  host: boundary.string,
  stopped: boundary.optional(stopSchema),
});
