import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const UNIT_MB = { B: 1 / (1024 * 1024), K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 } as const;
const isUnit = (unit: string): unit is keyof typeof UNIT_MB => unit in UNIT_MB;

/** `top -stats pid,mem` rows into pid → MB. */
export function parseTopFootprints(stdout: string): Map<number, number> {
  const footprints = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/u.exec(line);
    if (!match || !isUnit(match[3])) continue;
    footprints.set(Number(match[1]), Math.round(Number(match[2]) * UNIT_MB[match[3]] * 10) / 10);
  }
  return footprints;
}

/**
 * macOS only: each process's memory footprint, the figure Activity Monitor shows.
 * RSS leaves out compressed and swapped pages, so on a Mac short of memory a
 * leaking process can hold RSS flat while its footprint climbs. One top call
 * costs about 1.7 s of CPU in its own process, so callers read this once a leak slice.
 */
export async function readFootprints(): Promise<Map<number, number> | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('top', ['-l', '1', '-stats', 'pid,mem'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    return parseTopFootprints(stdout);
  } catch {
    return null;
  }
}
