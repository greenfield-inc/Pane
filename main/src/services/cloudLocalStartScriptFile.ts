import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { CloudLocalStartScript } from '../../../shared/types/cloudSandboxes';
import { getAppDirectory } from '../utils/appDirectory';

/** The user's local start script, kept only on this computer. */
export interface CloudLocalStartScriptFile {
  /** A blank script when none is saved. */
  read(): Promise<CloudLocalStartScript>;
  write(settings: CloudLocalStartScript): Promise<void>;
}

const settingsSchema = boundary.object({
  shell: boundary.enumeration('sh', 'powershell', 'cmd'),
  script: boundary.string,
});

/**
 * `<pane data dir>/cloud-sandboxes/local-start.json` (0600, beside startup.sh): the script and its shell. It runs on
 * THIS computer before each sandbox create and start; its KEY=VALUE output goes to that sandbox only.
 */
export function createCloudLocalStartScriptFile(defaultShell: CloudLocalStartScript['shell'], paneDir: string = getAppDirectory()): CloudLocalStartScriptFile {
  const dir = join(paneDir, 'cloud-sandboxes');
  const filePath = join(dir, 'local-start.json');
  return {
    async read() {
      let text: string;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { shell: defaultShell, script: '' };
        throw error;
      }
      try {
        return decodeBoundary(JSON.parse(text), settingsSchema);
      } catch {
        throw new Error(`${filePath} is not a saved local start script. Save the script again in Settings.`);
      }
    },
    async write(settings) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const temporaryPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify({ shell: settings.shell, script: settings.script })}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    },
  };
}
