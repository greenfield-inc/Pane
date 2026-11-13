import { homedir } from 'os';
import { join } from 'path';
import { existsSync, renameSync } from 'fs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

let customAppDir: string | undefined;

interface ElectronAppLike {
  isPackaged: boolean;
}

function getElectronApp(): ElectronAppLike | null {
  try {
    // In a plain Node process, `require('electron')` resolves to the Electron
    // binary path string rather than the runtime module. Guard that case.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule = require('electron');
    try {
      decodeBoundary(electronModule, boundary.string);
      return null;
    } catch {
      // The Electron runtime exposes the module object instead of the binary path.
    }

    // SAFETY: Electron's runtime module contract exposes `app`; plain Node's string case was excluded above.
    const electronApp = (electronModule as { app?: ElectronAppLike }).app;
    if (!electronApp) {
      return null;
    }

    return electronApp;
  } catch {
    return null;
  }
}

/**
 * Everything after the executable. User args start at argv[1] in packaged
 * builds (`Pane.exe --pane-dir X`) but at argv[2] in dev (`electron . --pane-dir X`),
 * so `slice(2)` would drop a packaged first argument. Scanning the dev script
 * path as well is harmless: it never looks like a flag.
 */
function getLaunchArgs(): string[] {
  return process.argv.slice(1);
}

export function getAppDirectoryOverrideFromArgs(args = getLaunchArgs()): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--pane-dir=')) {
      return arg.substring('--pane-dir='.length);
    }
    if (arg === '--pane-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith('--foozol-dir=')) {
      return arg.substring('--foozol-dir='.length);
    }
    if (arg === '--foozol-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

export function applyAppDirectoryOverrideFromArgs(args = getLaunchArgs()): string | undefined {
  const override = getAppDirectoryOverrideFromArgs(args);
  if (override) {
    setAppDirectory(override);
  }

  return override;
}

/**
 * The installed Pane: a packaged build on the default data directory. Dev
 * builds and --pane-dir/PANE_DIR instances run beside it.
 */
export function isPackagedOnDefaultDirectory(): boolean {
  return Boolean(getElectronApp()?.isPackaged) && !getAppDirectoryOverrideFromArgs() && !process.env.PANE_DIR && !process.env.FOOZOL_DIR;
}

/**
 * Sets a custom Pane directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
function setAppDirectory(dir: string): void {
  customAppDir = dir;
}

/**
 * Where Pane keeps its data when neither --pane-dir nor PANE_DIR names a
 * directory. A development (unpackaged) Electron build gets ~/.pane_dev, so it
 * never opens, migrates or cleans up the installed Pane's ~/.pane by accident.
 * Pointing one at ~/.pane takes an explicit PANE_DIR=~/.pane.
 */
export function defaultAppDirectory(electronApp: ElectronAppLike | null, home: string): string {
  if (electronApp && !electronApp.isPackaged) {
    return join(home, '.pane_dev');
  }
  return join(home, '.pane');
}

let announcedDevDirectory = false;

/**
 * Gets the Pane directory path. Returns the custom directory if set,
 * otherwise falls back to the environment variable PANE_DIR,
 * and finally to defaultAppDirectory()
 */
export function getAppDirectory(): string {
  // 1. Check if custom directory was set programmatically
  if (customAppDir) {
    return customAppDir;
  }

  // 2. Check CLI app-dir flags. This must happen inside getAppDirectory()
  // because services/database is imported before index.ts can parse argv.
  const cliDir = getAppDirectoryOverrideFromArgs();
  if (cliDir) {
    return cliDir;
  }

  // 3. Check environment variable (with legacy FOOZOL_DIR fallback)
  const envDir = process.env.PANE_DIR || process.env.FOOZOL_DIR;
  if (envDir) {
    return envDir;
  }

  // 4. The default: ~/.pane for packaged Pane, ~/.pane_dev for a development build.
  const electronApp = getElectronApp();
  const dir = defaultAppDirectory(electronApp, homedir());
  if (electronApp && !electronApp.isPackaged && !announcedDevDirectory) {
    announcedDevDirectory = true;
    console.log(`[Pane] Development build: using ${dir}, not the installed Pane's ~/.pane. Set PANE_DIR to choose another data directory.`);
  }
  return dir;
}

/**
 * Migrates the data directory from ~/.foozol to ~/.pane on first launch.
 * Should be called once during app startup, before any services are initialized.
 */
export function migrateDataDirectory(): void {
  // Skip migration if a custom directory is set (via --pane-dir, --foozol-dir, or env vars)
  // to avoid moving ~/.foozol out from under a running app that explicitly configured its path
  if (customAppDir || getAppDirectoryOverrideFromArgs() || process.env.PANE_DIR || process.env.FOOZOL_DIR) {
    return;
  }

  const home = homedir();
  const oldDir = join(home, '.foozol');
  const newDir = join(home, '.pane');
  const oldDevDir = join(home, '.foozol_dev');
  const newDevDir = join(home, '.pane_dev');

  // Migrate production directory
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      console.log(`[Pane] Migrated data directory: ${oldDir} → ${newDir}`);
    } catch (err) {
      console.error(`[Pane] Failed to migrate data directory: ${err}`);
    }
  }

  // Migrate dev directory
  if (!existsSync(newDevDir) && existsSync(oldDevDir)) {
    try {
      renameSync(oldDevDir, newDevDir);
      console.log(`[Pane] Migrated dev directory: ${oldDevDir} → ${newDevDir}`);
    } catch (err) {
      console.error(`[Pane] Failed to migrate dev directory: ${err}`);
    }
  }
}

/**
 * Gets a subdirectory path within the Pane directory
 */
export function getAppSubdirectory(...subPaths: string[]): string {
  return join(getAppDirectory(), ...subPaths);
}
