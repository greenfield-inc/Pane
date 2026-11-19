import { boundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { verbRequestSchema, type VerbRequest } from './pageVerbs';

/**
 * The route to a browser tab another of your computers shows (docs/BROWSER_AGENTS.md, P2). Each
 * desktop renders its own copy of a tab; when an agent's call finds a linked computer showing the
 * tab, that copy runs the call. Shaped like `runpane:machine:devices`: the HTTP listeners admit
 * `runpane:machine:` only for a linked computer's token or the owner, and every answer comes
 * within 10 seconds, as its result or a task to await.
 */
export const BROWSER_MACHINE_CHANNEL = 'runpane:machine:browser';

/** Screenshots larger than this cross in pieces. */
export const IMAGE_CHUNK_BYTES = 3 * 1024 * 1024;

const from = boundary.object({ id: boundary.string, name: boundary.string });
const file = boundary.object({ name: boundary.string, data: boundary.string });

export type LinkedBrowserRequest =
  | { op: 'probe'; from: { id: string; name: string }; panelId: string }
  | { op: 'run'; from: { id: string; name: string }; panelId: string; request: VerbRequest; files?: Array<{ name: string; data: string }> }
  | { op: 'await'; from: { id: string; name: string }; task: string }
  | { op: 'chunk'; from: { id: string; name: string }; image: string; offset: number };

export const linkedBrowserRequestSchema: BoundarySchema<LinkedBrowserRequest> = boundary.union(
  boundary.object({ op: boundary.literal('probe'), from, panelId: boundary.string }),
  boundary.object({ op: boundary.literal('run'), from, panelId: boundary.string, request: verbRequestSchema, files: boundary.optional(boundary.array(file)) }),
  boundary.object({ op: boundary.literal('await'), from, task: boundary.string }),
  boundary.object({ op: boundary.literal('chunk'), from, image: boundary.string, offset: boundary.number }),
);

const dialog = boundary.object({ type: boundary.enumeration('alert', 'confirm', 'prompt', 'beforeunload'), message: boundary.string, defaultPrompt: boundary.optional(boundary.string) });

/** A verb's outcome as it crosses: a screenshot's PNG stays on the viewer, fetched in chunks by id. */
const linkedOutcomeSchema = boundary.object({
  url: boundary.string,
  title: boundary.string,
  dialog: boundary.optional(dialog),
  fileChooser: boundary.optional(boundary.object({ multiple: boundary.boolean })),
  note: boundary.optional(boundary.string),
  snapshot: boundary.optional(boundary.string),
  truncated: boundary.optional(boundary.boolean),
  value: boundary.optional(boundary.json),
  image: boundary.optional(boundary.object({ id: boundary.string, size: boundary.number, width: boundary.number, height: boundary.number })),
});

/** What a run answers: the outcome, a task still running, or that the person is driving there now. */
export const linkedRunAnswerSchema = boundary.union(
  boundary.object({ outcome: linkedOutcomeSchema }),
  boundary.object({ pending: boundary.string }),
  boundary.object({ personDriving: boundary.literal(true) }),
);

export const linkedProbeAnswerSchema = boundary.object({ showing: boundary.boolean });
export const linkedChunkAnswerSchema = boundary.object({ data: boundary.string, done: boundary.boolean });
