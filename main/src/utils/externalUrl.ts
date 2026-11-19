import { realpath, stat } from 'fs/promises';
import { extname } from 'path';
import { fileURLToPath } from 'url';
import { PaneError } from '../../../shared/paneError';

/**
 * The only schemes Pane hands to the OS. Anything else (file:, javascript:, app
 * schemes such as vscode: or x-apple-systempreferences:) could launch a local
 * program from a link in untrusted content, so it is refused.
 */
const EXTERNAL_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** The normalized URL when `value` is an absolute http, https or mailto URL; otherwise null. */
export function externalUrlOrNull(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return EXTERNAL_URL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}

/**
 * Schemes a page in a browser tab never hands to the OS, even once the person agrees: they reach
 * local files or scripts, or are Windows handlers known to run programs from a link.
 */
const NEVER_APP_PROTOCOLS: ReadonlySet<string> = new Set([
  'file:', 'javascript:', 'data:', 'blob:', 'about:', 'filesystem:', 'view-source:', 'chrome:', 'chrome-extension:', 'devtools:',
  'pane:', 'smb:', 'ms-msdt:', 'search-ms:', 'search:', 'ms-officecmd:', 'ms-appinstaller:',
]);

/**
 * The URL when `value` is a link to an app on this computer that a page may ask to open
 * (zoommtg:, slack:, mailto:), with the person's OK; null for web links and refused schemes.
 */
export function appLinkOrNull(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const { protocol } = parsed;
  if (protocol === 'http:' || protocol === 'https:' || NEVER_APP_PROTOCOLS.has(protocol)) return null;
  return parsed.href;
}

/** The normalized URL to open in the system browser or mail client; throws for any other value. */
export function toExternalUrl(value: string): string {
  const url = externalUrlOrNull(value);
  if (url !== null) return url;
  throw new PaneError(
    'ERR_EXTERNAL_URL_BLOCKED',
    'Pane did not open this link: only http, https and mailto links open outside Pane. Nothing was opened.',
    'Copy the link and open it yourself if you trust it.',
  );
}

/** The page types a browser opens from disk. Any other file could be a program, so it is refused. */
const LOCAL_PAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm']);

/** On Windows, a local WSL distro's files are served from these hosts (`\\wsl.localhost\Ubuntu\...`). */
const WSL_FILE_HOST = /^wsl(?:\.localhost|\$)$/i;

/** The path of a `file:` URL that names a `.html` or `.htm` page on this computer; throws for anything else. */
export function toLocalPagePath(value: string): string {
  let path: string | null = null;
  try {
    const parsed = new URL(value);
    const onThisComputer = !parsed.host || (process.platform === 'win32' && WSL_FILE_HOST.test(parsed.hostname));
    if (parsed.protocol === 'file:' && onThisComputer) path = fileURLToPath(parsed);
  } catch {
    path = null;
  }
  if (path !== null && isLocalPageName(path)) return path;
  throw localPageBlocked();
}

/**
 * The real file a local page's `file:` URL names, to hand to the OS. A link is followed, and the file it reaches must
 * be a page too, so `page.html -> setup.command` is refused. Throws `ERR_LOCAL_PAGE_BLOCKED` or `ERR_LOCAL_PAGE_MISSING`.
 */
export async function toLocalPageFile(value: string): Promise<string> {
  const path = toLocalPagePath(value);
  const real = await realpath(path).catch(() => {
    throw new PaneError('ERR_LOCAL_PAGE_MISSING', `Pane did not open ${path} in your browser: the file no longer exists.`, 'Reload the tab, or open the page again.');
  });
  if (!isLocalPageName(real) || !(await stat(real)).isFile()) throw localPageBlocked();
  return real;
}

function isLocalPageName(path: string): boolean {
  return LOCAL_PAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function localPageBlocked(): PaneError {
  return new PaneError(
    'ERR_LOCAL_PAGE_BLOCKED',
    'Pane did not open this file in your browser: only .html and .htm files on this computer open there. Nothing was opened.',
    'Open the file from Finder or your file manager if you trust it.',
  );
}
