import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { writeNoteFile } from './noteFiles';

/** Cursor CLI does not load home rules from projects outside the home hierarchy.
 * Its documented user sessionStart hook supplies the same generated memory. */
export function exportCursorMemoryHook(directory: string, memory: string, platform: NodeJS.Platform): void {
  const file = path.join(directory, 'hooks.json');
  const contextFile = path.join(directory, 'pane-notes-context.json');
  for (const target of [file, contextFile]) {
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) {
      throw new Error('Cursor memory hook destination is not a regular file.');
    }
  }
  const config = fs.existsSync(file) ? decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.jsonObject) : { version: 1 };
  if (config.version !== 1) throw new Error('Unsupported Cursor hook configuration version.');
  const hooks = decodeBoundary(config.hooks ?? {}, boundary.jsonObject);
  const existing = decodeBoundary(hooks.sessionStart ?? [], boundary.array(boundary.jsonObject));
  const command = platform === 'win32'
    ? 'powershell.exe -NoProfile -NonInteractive -Command "Get-Content -Raw -LiteralPath \'./pane-notes-context.json\'"'
    : "cat './pane-notes-context.json'";
  const own = existing.filter(hook => hook.command === command);
  if (own.length > 1) throw new Error('Duplicate Pane Cursor memory hooks. Repair hooks.json and retry.');
  fs.mkdirSync(directory, { recursive: true });
  // PowerShell 5.1 defaults to the system code page. ASCII JSON escapes preserve
  // Unicode content through that pipeline without changing the user's console.
  writeNoteFile(contextFile, JSON.stringify({ additional_context: memory }).replace(/[\u0080-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
  if (!own.length) {
    writeNoteFile(file, JSON.stringify({ ...config, hooks: { ...hooks, sessionStart: [...existing, { command }] } }, null, 2) + '\n');
  }
}
