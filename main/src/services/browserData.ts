import { app, session, webContents } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { DOCS_BROWSER_PARTITION, SHARED_BROWSER_PARTITION } from '../../../shared/constants/browserPartitions';
import { PaneError, reasonOf } from '../../../shared/paneError';

/** Folders under `<userData>/Partitions` that Clear browser data keeps: the stores Pane still uses. */
const KEPT_PARTITION_FOLDERS: ReadonlySet<string> = new Set(
  [SHARED_BROWSER_PARTITION, DOCS_BROWSER_PARTITION].map(partition => partition.replace(/^persist:/, '')),
);

interface ClearBrowserDataDeps {
  userDataPath: string;
  sharedSession: {
    clearStorageData(): Promise<void>;
    clearCache(): Promise<void>;
    /** Forgets saved HTTP (Basic/Digest) sign-ins, which clearStorageData leaves in place. */
    clearAuthCache(): Promise<void>;
    /** Drops open connections, which would otherwise keep sending the forgotten sign-ins. */
    closeAllConnections(): Promise<void>;
  };
  reloadBrowserTabs(): void;
  /** Deletes one leftover store. `fs.rm` removes a link itself, never what it points to. */
  removeStore?: (target: string) => Promise<void>;
}

/**
 * Signs out of every site in Pane's browser: clears the shared store and its saved
 * HTTP sign-ins, deletes the per-project and per-Session stores older versions left
 * behind, and reloads open tabs. Once cookies and site data are cleared, every other
 * step still runs when one fails, and running it again retries what failed.
 */
export async function clearBrowserData({
  userDataPath,
  sharedSession,
  reloadBrowserTabs,
  removeStore = target => fs.rm(target, { recursive: true, force: true }),
}: ClearBrowserDataDeps): Promise<void> {
  await sharedSession.clearStorageData();

  const authFailure = await failureOf(async () => {
    await sharedSession.clearAuthCache();
    await sharedSession.closeAllConnections();
  });
  const cacheFailure = await failureOf(() => sharedSession.clearCache());

  const partitionsDir = path.join(userDataPath, 'Partitions');
  let storeFailure: { target: string; cause: unknown } | null = null;
  let leftovers: string[] = [];
  try {
    leftovers = await leftoverStoreNames(partitionsDir);
  } catch (cause) {
    storeFailure = { target: partitionsDir, cause };
  }
  for (const name of leftovers) {
    const target = path.join(partitionsDir, name);
    try {
      await removeStore(target);
    } catch (cause) {
      storeFailure ??= { target, cause };
    }
  }

  reloadBrowserTabs();

  const failures: string[] = [];
  if (authFailure) failures.push(`clear saved site passwords: ${reasonOf(authFailure.cause)}. Sites that use them may still be signed in.`);
  if (cacheFailure) failures.push(`clear the browser cache: ${reasonOf(cacheFailure.cause)}. Pages may still show copies saved before you cleared.`);
  if (storeFailure) failures.push(`remove some older browser data at ${storeFailure.target}: ${reasonOf(storeFailure.cause)}.`);
  if (failures.length === 0) return;

  const cleared = authFailure ? 'Pane cleared cookies and site data' : 'Pane cleared your logins';
  const message = [`${cleared} but couldn't ${failures[0]}`, ...failures.slice(1).map(failure => `It also couldn't ${failure}`)].join(' ');
  if (!authFailure && !cacheFailure) {
    throw new PaneError('browser-data-cleanup-incomplete', message, 'Close any open browser tabs and run Clear browser data again.');
  }
  throw new PaneError(
    'browser-data-clear-incomplete',
    message,
    'Run Clear browser data again. If it fails again, quit and reopen Pane, then run it once more.',
  );
}

interface StepFailure { cause: unknown }

async function failureOf(step: () => Promise<void>): Promise<StepFailure | null> {
  try {
    await step();
    return null;
  } catch (cause) {
    return { cause };
  }
}

async function leftoverStoreNames(partitionsDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(partitionsDir)).filter(name => !KEPT_PARTITION_FOLDERS.has(name));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Clears this computer's browser data in the running app and reloads its open browser tabs. */
export function clearPaneBrowserData(): Promise<void> {
  const sharedSession = session.fromPartition(SHARED_BROWSER_PARTITION);
  return clearBrowserData({
    userDataPath: app.getPath('userData'),
    sharedSession,
    reloadBrowserTabs: () => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.getType() === 'webview' && contents.session === sharedSession) contents.reload();
      }
    },
  });
}
