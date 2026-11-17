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

/** The path of a `file:` URL that names a local `.html` or `.htm` page; throws for anything else. */
export function toLocalPagePath(value: string): string {
  let path: string | null = null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:' && !parsed.host) path = fileURLToPath(parsed);
  } catch {
    path = null;
  }
  if (path !== null && LOCAL_PAGE_EXTENSIONS.has(extname(path).toLowerCase())) return path;
  throw new PaneError(
    'ERR_LOCAL_PAGE_BLOCKED',
    'Pane did not open this file in your browser: only .html and .htm files on this computer open there. Nothing was opened.',
    'Open the file from Finder or your file manager if you trust it.',
  );
}
