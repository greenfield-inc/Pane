import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import type { Note } from '../../../shared/types/notes';
import { writeNoteFile } from './noteFiles';

const START = '<!-- pane-memories:start -->';
const END = '<!-- pane-memories:end -->';

/** Fail closed on ambiguous markers; preserve every byte outside a valid pair. */
function replaceMemory(existing: string, body: string): string {
  const starts = existing.split(START).length - 1;
  const ends = existing.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts === 1 && existing.indexOf(END) < existing.indexOf(START))) {
    throw new Error('Malformed Pane memory markers. Repair the markers and retry; this file was not changed.');
  }
  const block = body ? `${START}\n## Pane memories\n\n${body}\n${END}` : '';
  if (starts) return existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length);
  return block ? existing + (existing ? '\n\n' : '') + block + '\n' : existing;
}

function reference(from: string, to: string): string {
  // Across Windows drive letters a relative path is impossible; file URLs remain
  // resolvable on this installation, without leaking paths into canonical notes.
  const relative = path.relative(path.dirname(from), to);
  if (path.isAbsolute(relative)) return pathToFileURL(to).href;
  return relative.split(path.sep).map(part => encodeURIComponent(part)).join('/');
}

export function exportNoteMemories(root: string, file: string, notes: Note[], preamble = ''): void {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  const status = entry ? fs.statSync(file) : undefined;
  if (status && !status.isFile()) throw new Error('Instruction destination is not a regular file.');
  const existing = status ? fs.readFileSync(file, 'utf8') : '';
  // Validate markers before generating assets or touching instructions.
  replaceMemory(existing, '');
  const owner = createHash('sha256').update(path.resolve(root)).digest('hex');
  const existingOwner = existing.match(/<!-- pane-memories:store ([a-f0-9]+) -->/)?.[1];
  if (existingOwner && existingOwner !== owner) throw new Error('This instruction file contains notes from another Pane data directory. Its memory was left unchanged.');
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
      if (!fs.existsSync(`${asset}.png`)) fs.writeFileSync(`${asset}.png`, Buffer.from(block.png.split(',')[1], 'base64'), { mode: 0o600 });
      const label = block.title.replace(/[\r\n[\]]/g, ' ') || 'Drawing';
      lines.push(`Drawing: ${label}`, `Labels: ${block.labels.replace(/[\r\n]+/g, ' ')}`, `[Editable drawing](${reference(file, `${asset}.excalidraw`)})`,
        `![${label}](${reference(file, `${asset}.png`)})`, '');
    }
  }
  // Notes are literal user content: escaping marker strings prevents a note from
  // making the next managed update ambiguous.
  const body = lines.join('\n').replaceAll(START, '&lt;!-- pane-memories:start --&gt;').replaceAll(END, '&lt;!-- pane-memories:end --&gt;');
  const prefix = !status && body && path.extname(file) === '.mdc' ? '---\nalwaysApply: true\n---\n\n' : '';
  const next = prefix + replaceMemory(existing, body ? `<!-- pane-memories:store ${owner} -->\n${body}` : '');
  if (existing === next) return;
  writeNoteFile(file, next);
}
