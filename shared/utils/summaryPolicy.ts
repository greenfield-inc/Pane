import { NOTIFY_SUMMARY_CSP } from '../types/notify';

const PREFIX = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${NOTIFY_SUMMARY_CSP}">`;

/**
 * The Summary frame's sandbox: same-origin so Pane's find can read and highlight the page, and
 * nothing else, so no script in it ever runs. tests/summary-policy.spec.ts loads hostile pages
 * into a frame with exactly this string.
 */
export const SUMMARY_FRAME_SANDBOX = 'allow-same-origin';

/**
 * An approval's Summary page with NOTIFY_SUMMARY_CSP as the very first thing in it, so the policy
 * holds before anything in the page loads. Pane's own doctype and the policy always come first,
 * whatever the page starts with: the parser then opens the real head for the policy itself, so no
 * leading character, comment, or `<head>` hidden in a script or an attribute can move it. The
 * page's own leading doctype is dropped (a later one is ignored by the parser). Applying it twice
 * changes nothing.
 */
export function withSummaryPolicy(html: string): string {
  if (html.startsWith(PREFIX)) return html;
  return `${PREFIX}${html.replace(/^\uFEFF?(?:[\t\n\f\r ]*<!doctype[^>]*>)?/iu, '')}`;
}
