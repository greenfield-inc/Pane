import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

/**
 * A side-by-side build is a test build packaged with `paneSideBySide` in its
 * package.json (`electron-builder -c.extraMetadata.paneSideBySide=<name>`). It
 * runs beside an installed Pane without touching it:
 *
 * - its data directory defaults to `~/.pane_<name>` instead of `~/.pane`;
 * - its Chromium profile, and so its single-instance lock, lives in that data directory;
 * - it makes no machine-wide registrations: no login item, no `pane://` handler,
 *   no MCP server or home skill in agent configs, and no update checks.
 *
 * Installed builds never carry the field, so none of this changes them.
 */
const SIDE_BY_SIDE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Reads the side-by-side name from the text of a packaged package.json. */
export function parseSideBySideName(packageJsonText: string): string | null {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  const decoded = decodeOptionalBoundary(packageJson, boundary.object({ paneSideBySide: boundary.string }));
  if (!decoded || !SIDE_BY_SIDE_NAME.test(decoded.paneSideBySide)) return null;
  return decoded.paneSideBySide;
}

let cachedName: string | null | undefined;

interface PackagedAppLike {
  isPackaged: boolean;
  getAppPath(): string;
}

function getPackagedApp(): PackagedAppLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule: unknown = require('electron');
    // Plain Node resolves `electron` to the binary path string.
    if (decodeOptionalBoundary(electronModule, boundary.string) !== undefined) return null;
    // SAFETY: the Electron runtime module exposes `app`; the plain-Node string case was excluded above.
    const electronApp = (electronModule as { app?: PackagedAppLike }).app;
    return electronApp?.isPackaged ? electronApp : null;
  } catch {
    return null;
  }
}

/** The side-by-side name of this packaged build, or null for a normal build. */
export function getSideBySideName(): string | null {
  if (cachedName !== undefined) return cachedName;
  const electronApp = getPackagedApp();
  cachedName = null;
  if (electronApp) {
    try {
      cachedName = parseSideBySideName(readFileSync(join(electronApp.getAppPath(), 'package.json'), 'utf8'));
    } catch {
      cachedName = null;
    }
  }
  return cachedName;
}

export function isSideBySideBuild(): boolean {
  return getSideBySideName() !== null;
}

export function sideBySideDataDir(name: string, home = homedir()): string {
  return join(home, `.pane_${name}`);
}

/** Chromium profile directory for a side-by-side build: inside its data directory. */
export function sideBySideUserDataDir(appDirectory: string): string {
  return join(appDirectory, 'chromium-profile');
}
