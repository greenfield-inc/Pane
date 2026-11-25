import fs from 'fs/promises';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { loginSitesProblem, paneSecretKey, type PaneLoginUse } from '../../../shared/types/paneSecrets';

/** A login as its value is stored: the sites travel with the value, so changing them takes the value. */
export interface StoredLogin {
  sites: string[];
  value: string;
}

const storedLoginSchema = boundary.object({ sites: boundary.array(boundary.string), value: boundary.nonEmptyString });

export function encodeLogin(login: StoredLogin): string {
  return JSON.stringify({ sites: login.sites, value: login.value });
}

/** The stored login, or null when the text isn't one Pane wrote. Never throws, so no error carries the text. */
export function decodeLogin(text: string): StoredLogin | null {
  try {
    const login = decodeBoundary(JSON.parse(text), storedLoginSchema);
    return loginSitesProblem(login.sites) ? null : login;
  } catch {
    return null;
  }
}

export function secretIsLogin(project: string, name: string): PaneError {
  return new PaneError(
    'SECRET_IS_LOGIN',
    `${paneSecretKey(project, name)} is a login, which Pane only fills on its sites in a browser tab. Nothing was run or changed.`,
    `Fill it with \`runpane browser fill --project ${project} --name ${name} --ref <ref>\`. Only the person changes a login, in Settings → Secrets.`,
  );
}

const useSchema = boundary.object({
  project: boundary.string,
  name: boundary.string,
  site: boundary.string,
  agent: boundary.string,
  pane: boundary.string,
  at: boundary.string,
});

export const loginUsesSchema = boundary.array(useSchema);

/** Uses a listing shows, and how much of the log's end it reads to find them. */
const LISTED_USES = 50;
const TAIL_BYTES = 32 * 1024;

/** Every fill of a saved login on this machine, one JSON line each in `login-uses.log`. Names and times, never values. */
export class LoginUseLog {
  constructor(private readonly directory: string, private readonly onChange: () => void = () => undefined) {}

  private get file(): string {
    return path.join(this.directory, 'login-uses.log');
  }

  /** Writes the use before the fill. Throws when it can't, so no login is filled unrecorded. */
  async record(use: PaneLoginUse): Promise<void> {
    try {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify(use)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new PaneError(
        'SECRET_WRITE_FAILED',
        `Pane could not record the use of ${paneSecretKey(use.project, use.name)}: ${reasonOf(error)}. Nothing was filled.`,
        'Check that Pane can write to its data directory, then try again.',
      );
    }
    this.onChange();
  }

  /** The newest uses, newest first. */
  async recent(): Promise<PaneLoginUse[]> {
    const handle = await fs.open(this.file, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return [];
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      // A read that starts mid-file starts mid-line.
      if (start > 0) lines.shift();
      const uses = lines.flatMap(line => {
        try {
          return line ? [decodeBoundary(JSON.parse(line), useSchema)] : [];
        } catch {
          return [];
        }
      });
      return uses.slice(-LISTED_USES).reverse();
    } finally {
      await handle.close();
    }
  }
}
