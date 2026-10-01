import { homedir } from 'os';
import { join } from 'path';
import { existsSync, renameSync } from 'fs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { getSideBySideName, sideBySideDataDir } from './sideBySide';

let customAppDir: string | undefined;

interface ElectronAppLike {
  isPackaged: boolean;
  getPath(name: 'exe'): string;
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

export function getAppDirectoryOverrideFromArgs(args = process.argv.slice(2)): string | undefined {
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

export function applyAppDirectoryOverrideFromArgs(args = process.argv.slice(2)): string | undefined {
  const override = getAppDirectoryOverrideFromArgs(args);
  if (override) {
    setAppDirectory(override);
  }

  return override;
}

/**
 * Sets a custom Pane directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
function setAppDirectory(dir: string): void {
  customAppDir = dir;
}

/**
 * Determines if Pane is running from an installed application (DMG/Applications folder)
 * rather than a development build
 */
function isInstalledApp(): boolean {
  const electronApp = getElectronApp();

  // Check if app is packaged (built for distribution)
  if (!electronApp?.isPackaged) {
    return false;
  }
  
  // On macOS, check if running from /Applications or a mounted DMG volume
  if (process.platform === 'darwin') {
    const appPath = electronApp.getPath('exe');
    // Apps installed from DMG or in /Applications will have these paths
    const isInApplications = appPath.startsWith('/Applications/');
    const isInVolumes = appPath.startsWith('/Volumes/');
    const isInPrivateTmp = appPath.includes('/private/var/folders/'); // Temp mount for DMG
    
    return isInApplications || isInVolumes || isInPrivateTmp;
  }
  
  // For other platforms, being packaged is sufficient
  return true;
}

/**
 * Gets the Pane directory path. Returns the custom directory if set,
 * otherwise falls back to the environment variable PANE_DIR,
 * and finally defaults to ~/.pane
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

  // 4. A side-by-side test build keeps its own default so it never opens the installed Pane's data
  const sideBySideName = getSideBySideName();
  if (sideBySideName) {
    return sideBySideDataDir(sideBySideName);
  }

  // 5. If running as an installed app (from DMG, /Applications, etc), always use ~/.pane
  if (isInstalledApp()) {
    console.log('[Pane] Running as installed app, using ~/.pane');
    return join(homedir(), '.pane');
  }

  // 6. If running inside Pane (detected by bundle identifier) in development, use development directory
  // This prevents development Pane from interfering with production Pane
  const electronApp = getElectronApp();
  if (process.env.__CFBundleIdentifier === 'com.dcouple.pane' && !electronApp?.isPackaged) {
    console.log('[Pane] Detected running inside Pane development, using ~/.pane_dev for isolation');
    return join(homedir(), '.pane_dev');
  }

  // 7. Default to ~/.pane
  return join(homedir(), '.pane');
}

/**
 * Migrates the data directory from ~/.foozol to ~/.pane on first launch.
 * Should be called once during app startup, before any services are initialized.
 */
export function migrateDataDirectory(): void {
  // Skip migration if a custom directory is set (via --pane-dir, --foozol-dir, or env vars)
  // to avoid moving ~/.foozol out from under a running app that explicitly configured its path.
  // A side-by-side build never moves the installed Pane's directories.
  if (customAppDir || getAppDirectoryOverrideFromArgs() || process.env.PANE_DIR || process.env.FOOZOL_DIR || getSideBySideName()) {
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
