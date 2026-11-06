import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import type { CloudStartupScriptFile } from './cloudSandboxes';

/**
 * The user's cloud sandbox startup script: `<pane data dir>/cloud-sandboxes/startup.sh`, on this computer only and
 * unencrypted (the editor says not to put secrets in it). The cloud library pushes it to each sandbox on create and start.
 */
export function createCloudStartupScriptFile(paneDir: string = getAppDirectory()): CloudStartupScriptFile {
  const dir = join(paneDir, 'cloud-sandboxes');
  const scriptPath = join(dir, 'startup.sh');
  return {
    async read() {
      try {
        return await fs.readFile(scriptPath, 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
        throw error;
      }
    },
    async write(script) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const temporaryPath = `${scriptPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(temporaryPath, script, { mode: 0o600 });
      await fs.rename(temporaryPath, scriptPath);
    },
  };
}
