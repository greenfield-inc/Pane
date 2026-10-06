import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export function noteContextPath(root: string, paneId: string): string {
  return path.join(root, 'contexts', `${encodeURIComponent(paneId)}.md`);
}

export const SCOPED_NOTE_INSTRUCTIONS = `### Scoped notes in Pane
Before answering each user turn, check the PANE_NOTES_FILE environment variable. If it is set and the file exists, read that file for this Pane's current project, feature, or Session notes. Resolve its drawing links relative to that file. Do not load another Pane's scoped notes. If the variable is unset or the file does not exist, no scoped Pane notes apply. Saving notes does not itself request agent work.`;

/** Keep dotfile symlinks and permissions; readers never see a partial export. */
export function writeNoteFile(file: string, content: string | Buffer): void {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  const target = entry ? fs.realpathSync(file) : file;
  const status = entry ? fs.statSync(target) : undefined;
  if (status && !status.isFile()) throw new Error('Note destination is not a regular file.');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (status && fs.readFileSync(target).equals(bytes)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: status?.mode ?? 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
