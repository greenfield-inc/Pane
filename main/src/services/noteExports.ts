import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import type { Note } from '../../../shared/types/notes';
import { writeNoteFile } from './noteFiles';
import { writeOwnedBlock, type BlockMarkers } from './instructionsBlock';

const START = '<!-- pane-memories:start -->';
const END = '<!-- pane-memories:end -->';

const MARKERS: BlockMarkers = { begin: START, end: END, repair: 'save the note again' };

function reference(from: string, to: string): string {
  // Across Windows drive letters a relative path is impossible; file URLs remain
  // resolvable on this installation, without leaking paths into canonical notes.
  const relative = path.relative(path.dirname(from), to);
  if (path.isAbsolute(relative)) return pathToFileURL(to).href;
  return relative.split(path.sep).map(part => encodeURIComponent(part)).join('/');
}

export function exportNoteMemories(root: string, file: string, notes: Note[], preamble = ''): void {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  // A symlinked instruction file (dotfiles) is edited at its target, and the link stays.
  const target = entry?.isSymbolicLink() ? fs.realpathSync(file) : file;
  const status = entry ? fs.statSync(target) : undefined;
  if (status && !status.isFile()) throw new Error('Instruction destination is not a regular file.');
  const existing = status ? fs.readFileSync(target, 'utf8') : '';
  const owner = createHash('sha256').update(path.resolve(root)).digest('hex');
  const existingOwner = existing.match(/<!-- pane-memories:store ([a-f0-9]+) -->/)?.[1];
  if (existingOwner && existingOwner !== owner) throw new Error('This instruction file contains notes from another Pane data directory. To switch stores, back up the file and remove only its pane-memories section, then retry. Nothing was changed.');
  const lines: string[] = preamble ? [preamble, ''] : [];
  for (const note of notes) {
    lines.push(`### ${note.title.replace(/[\r\n]/g, ' ') || 'Untitled note'}`, '');
    for (const block of note.blocks) {
      if (block.type === 'text') { lines.push(block.text, ''); continue; }
      const scene = JSON.stringify(block.scene);
      const digest = createHash('sha256').update(scene).update(block.png).digest('hex');
      const asset = path.join(root, 'assets', digest);
      fs.mkdirSync(path.dirname(asset), { recursive: true, mode: 0o700 });
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(block.png)) throw new Error('Drawing preview is missing. Reopen and save the drawing.');
      if (!fs.existsSync(`${asset}.excalidraw`)) writeNoteFile(`${asset}.excalidraw`, scene);
      const png = Buffer.from(block.png.split(',')[1], 'base64');
      if (fs.statSync(`${asset}.png`, { throwIfNoEntry: false })?.size !== png.length) writeNoteFile(`${asset}.png`, png);
      const label = block.title.replace(/[\r\n[\]]/g, ' ') || 'Drawing';
      lines.push(`Drawing: ${label}`, `Labels: ${block.labels.replace(/[\r\n]+/g, ' ')}`, `[Editable drawing](${reference(file, `${asset}.excalidraw`)})`,
        `![${label}](${reference(file, `${asset}.png`)})`, '');
    }
  }
  // Notes are literal user content: escaping marker strings prevents a note from
  // making the next managed update ambiguous.
  const body = lines.join('\n').replaceAll(START, '&lt;!-- pane-memories:start --&gt;').replaceAll(END, '&lt;!-- pane-memories:end --&gt;');
  if (body) fs.mkdirSync(path.dirname(target), { recursive: true });
  // This front matter makes Cursor apply the rules file Pane creates in every chat.
  if (!status && body && path.extname(file) === '.mdc') writeNoteFile(file, '---\nalwaysApply: true\n---\n\n');
  writeOwnedBlock(target, MARKERS, body
    ? [START, '## Pane memories', '', `<!-- pane-memories:store ${owner} -->`, ...body.split('\n'), END]
    : undefined);
}
