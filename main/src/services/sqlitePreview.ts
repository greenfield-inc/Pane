import { spawn } from 'child_process';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { FilePreviewListing } from '../../../shared/types/filePreview';

// A child can be killed even while SQLite is executing native code. Paths travel
// as argv, never as executable source. Electron's Node mode keeps the addon ABI.
const INSPECT_SCHEMA = `
  const Database = require(process.argv[1]);
  const database = new Database(process.argv[2], { readonly: true, fileMustExist: true });
  try {
    database.pragma('trusted_schema = OFF');
    const rows = database.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name LIMIT 1001").all();
    process.stdout.write(JSON.stringify(rows));
  } finally { database.close(); }
`;
const rowsSchema = boundary.array(boundary.object({ name: boundary.string, type: boundary.enumeration('table', 'view') }));

/** Inspect only a disposable snapshot, with bounded output and a main-thread deadline. */
export function inspectSqliteSnapshot(snapshot: string, deadlineMs: number): Promise<FilePreviewListing> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', '-e', INSPECT_SCHEMA, require.resolve('better-sqlite3-multiple-ciphers'), snapshot], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let failure: Error | undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('SQLite preview timed out. Open a smaller database copy or use a system app.'), deadlineMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop('SQLite schema exceeds the 1 MiB preview output limit.');
      else chunks.push(chunk);
    });
    child.once('error', () => { failure ??= new Error('Cannot start the SQLite preview process.'); });
    // Wait for termination before deleting the snapshot, including on Windows.
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error('Cannot preview this SQLite database.')); return; }
      try {
        const rows = decodeBoundary(JSON.parse(Buffer.concat(chunks).toString('utf8')), rowsSchema);
        resolve({
          columns: ['Name', 'Type'],
          rows: rows.slice(0, 1000).map(row => [row.name, row.type]),
          notice: `Tables and views only; rows are not queried.${rows.length > 1000 ? ' Limited to 1,000 entries.' : ''}`,
        });
      } catch { reject(new Error('Cannot read this SQLite schema.')); }
    });
  });
}
