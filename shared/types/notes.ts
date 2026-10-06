import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';
import type { JsonObject } from '../validation/boundaryDecoder';

export interface NoteScope { kind: 'feature' | 'project' | 'global' | 'session'; id: string }
export type NoteBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'drawing'; id: string; title: string; labels: string; scene: JsonObject; png: string };
export interface Note {
  id: string;
  revision: number;
  scope: NoteScope;
  references: NoteScope[];
  title: string;
  blocks: NoteBlock[];
  createdAt: string;
}
export interface NoteContext { scopes: { scope: NoteScope; name: string }[]; defaultScope: NoteScope }
export interface NoteExportResult { agent: string; path: string; error?: string }
export interface NoteSaveResult { note: Note; exports: NoteExportResult[] }
export interface NoteMutation {
  action: 'create' | 'save' | 'move' | 'remove' | 'retry';
  scope?: NoteScope; note?: Note; title?: string; id?: string; revision?: number;
}

export const noteScopeSchema: BoundarySchema<NoteScope> = boundary.object({
  kind: boundary.enumeration('feature', 'project', 'global', 'session'), id: boundary.nonEmptyString,
});
export const noteSchema: BoundarySchema<Note> = boundary.object({
  id: boundary.nonEmptyString, revision: boundary.number, scope: noteScopeSchema,
  references: boundary.array(noteScopeSchema), title: boundary.string, createdAt: boundary.string,
  blocks: boundary.array(boundary.union(
    boundary.object({ type: boundary.literal('text'), id: boundary.nonEmptyString, text: boundary.string }),
    boundary.object({ type: boundary.literal('drawing'), id: boundary.nonEmptyString, title: boundary.string,
      labels: boundary.string, scene: boundary.jsonObject, png: boundary.string }),
  )),
});
export function sameNoteScope(a: NoteScope, b: NoteScope): boolean { return a.kind === b.kind && a.id === b.id; }
