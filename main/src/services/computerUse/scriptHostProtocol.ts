import { boundary, type BoundarySchema, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { EngineImage, EngineResult } from './engine';

/** Messages between the daemon and a script process, over the child's IPC channel. */
export type ParentMessage =
  | { type: 'run'; runId: number; code: string; maxOutputChars: number }
  | { type: 'callResult'; callId: number; result: EngineResult }
  /** The lanes a `hold` asked for are now this host's alone. */
  | { type: 'held'; holdId: number };

export type ChildMessage =
  | { type: 'call'; callId: number; tool: string; args: JsonObject }
  /** Keeps other agents off an app (and the clipboard) across several calls, until `release`. */
  | { type: 'hold'; holdId: number; pid?: number; clipboard: boolean }
  | { type: 'release'; holdId: number }
  | { type: 'done'; runId: number; ok: boolean; text: string; images: EngineImage[] };

export const imageSchema = boundary.object({ mime: boundary.string, base64: boundary.string });

export const childMessageSchema: BoundarySchema<ChildMessage> = boundary.union(
  boundary.object({
    type: boundary.literal('call'),
    callId: boundary.number,
    tool: boundary.nonEmptyString,
    args: boundary.jsonObject,
  }),
  boundary.object({
    type: boundary.literal('hold'),
    holdId: boundary.number,
    pid: boundary.optional(boundary.number),
    clipboard: boundary.boolean,
  }),
  boundary.object({ type: boundary.literal('release'), holdId: boundary.number }),
  boundary.object({
    type: boundary.literal('done'),
    runId: boundary.number,
    ok: boundary.boolean,
    text: boundary.string,
    images: boundary.array(imageSchema),
  }),
);
