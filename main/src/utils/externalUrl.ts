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
