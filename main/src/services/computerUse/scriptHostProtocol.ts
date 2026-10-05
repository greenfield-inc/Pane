import type { JsonObject, JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { EngineImage, EngineResult } from './engine';

/** Messages between the daemon and a script process, over the child's IPC channel. */
export type ParentMessage =
  | { type: 'run'; runId: number; code: string }
  | { type: 'callResult'; callId: number; result: EngineResult };

export type ChildMessage =
  | { type: 'call'; callId: number; tool: string; args: JsonObject }
  /** A step our layer took, for the replay; the daemon validates it. */
  | { type: 'step'; step: JsonValue }
  | { type: 'done'; runId: number; ok: boolean; text: string; images: EngineImage[] };
