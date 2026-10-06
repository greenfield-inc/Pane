import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { noteSchema, sameNoteScope, type Note, type NoteScope } from '../../../shared/types/notes';

/** One host-owned store outside disposable worktrees. All mutations are synchronous
 * and atomically replaced; revisions protect separate renderer editors. */
export class Notes {
  constructor(private readonly root: string) {}

  private read(): Note[] {
    const file = path.join(this.root, 'notes.json');
    if (!fs.existsSync(file)) return [];
    return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.array(noteSchema));
  }

  private write(notes: Note[]): void {
    const payload = JSON.stringify(notes);
    if (Buffer.byteLength(payload) > 50_000_000) throw new Error('Notebook exceeds the 50 MB storage limit.');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `notes-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, path.join(this.root, 'notes.json'));
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  list(scope: NoteScope): Note[] {
    return this.read().filter(note => sameNoteScope(note.scope, scope) || note.references.some(ref => sameNoteScope(ref, scope)));
  }

  create(scope: NoteScope, title: string): Note {
    const note: Note = { id: randomUUID(), revision: 1, scope, references: [], title,
      blocks: [{ type: 'text', id: randomUUID(), text: '' }], createdAt: new Date().toISOString() };
    this.write([...this.read(), note]);
    return note;
  }

  save(input: Note): Note {
    const validated = decodeBoundary(input, noteSchema);
    const notes = this.read();
    const index = this.currentIndex(notes, input.id, input.revision);
    const current = notes[index];
    const note = { ...current, title: validated.title, blocks: validated.blocks, revision: current.revision + 1 };
    if (new Set(note.blocks.map(block => block.id)).size !== note.blocks.length) throw new Error('Duplicate block identifiers.');
    notes[index] = note;
    this.write(notes);
    return note;
  }

  move(id: string, revision: number, scope: NoteScope): Note {
    const notes = this.read();
    const index = this.currentIndex(notes, id, revision);
    const current = notes[index];
    const allowed = ((current.scope.kind === 'feature' || current.scope.kind === 'session') && scope.kind === 'project')
      || (current.scope.kind === 'project' && scope.kind === 'global');
    if (!allowed) throw new Error('Notes can only move from Feature or Session to Project, then to Global.');
    const note = { ...current, scope, references: [...current.references, current.scope], revision: revision + 1 };
    notes[index] = note;
    this.write(notes);
    return note;
  }

  remove(id: string, revision: number): void {
    const notes = this.read();
    notes.splice(this.currentIndex(notes, id, revision), 1);
    this.write(notes);
  }

  private currentIndex(notes: Note[], id: string, revision: number): number {
    const index = notes.findIndex(note => note.id === id);
    if (index < 0) throw new Error('This note was deleted. Your draft has been kept.');
    if (notes[index].revision !== revision) throw new Error('This note changed in another view. Your draft has been kept; reload to see the saved version.');
    return index;
  }
}
