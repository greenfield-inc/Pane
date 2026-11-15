import { NOTIFY_SUMMARY_CSP } from '../types/notify';

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${NOTIFY_SUMMARY_CSP}">`;

/**
 * An approval's Summary page with NOTIFY_SUMMARY_CSP ahead of all its content, so the policy holds
 * before anything in the page loads. Only a leading doctype stays in front: the parser then opens
 * the real head for the policy itself, and a `<head>` hidden in a comment, a script or an attribute
 * can't capture it. Applying it twice changes nothing.
 */
export function withSummaryPolicy(html: string): string {
  const page = html.replace(/^﻿/u, '');
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(page)?.[0];
  if (doctype && page.startsWith(POLICY_META, doctype.length)) return page;
  if (doctype) return `${doctype}${POLICY_META}${page.slice(doctype.length)}`;
  return `<!doctype html>${POLICY_META}${page}`;
}
