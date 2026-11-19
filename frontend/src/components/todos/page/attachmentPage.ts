import type { AutopilotDocument } from '../../../../../shared/types/autopilot';

/**
 * The frame flags an attached page gets wherever Pane shows one (the phone's Files tab, another
 * machine's document): none, so no scripts, forms, popups or navigation, and an opaque origin.
 */
export const ATTACHMENT_FRAME_SANDBOX = '';

const escapeAttribute = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/**
 * The page a new tab shows for an attached HTML file: Pane's own wrapper, whose only content is a
 * sandboxed frame holding the file as `srcdoc`. The file never becomes the tab's document, so its
 * scripts can't run with Pane's origin, read its storage (saved computers and their tokens) or
 * reach the opener.
 */
export function attachmentWrapperPage(html: string, title: string): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    // Inherited by the srcdoc frame too: belt and braces over the sandbox.
    + '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    + '<meta name="color-scheme" content="light dark">'
    + `<title>${escapeAttribute(title)}</title>`
    + '<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>'
    + `</head><body><iframe sandbox="${ATTACHMENT_FRAME_SANDBOX}" title="${escapeAttribute(title)}" srcdoc="${escapeAttribute(html)}"></iframe></body></html>`;
}

/** A read document as a file a browser tab can show on its own, or null when it has none. */
function attachmentDocAsPage(doc: AutopilotDocument, title: string): Blob | null {
  if (doc.kind === 'html' && doc.html !== undefined) return new Blob([attachmentWrapperPage(doc.html, title)], { type: 'text/html' });
  if (doc.kind === 'text') return new Blob([doc.text], { type: 'text/plain' });
  return null;
}

/**
 * Open ↗ for a file read through the API (the phone can't reach the computer's file): a tab opened
 * now, inside the tap, so the browser doesn't block it, cut off from this page at once, then
 * filled with the read copy once it arrives (an HTML page inside {@link attachmentWrapperPage}).
 * `noopener` can't be passed to `window.open` here, since it returns no tab to fill; clearing the
 * tab's `opener` before anything loads severs the same link.
 */
export function openAttachmentCopy(read: () => Promise<AutopilotDocument>, title: string): void {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  void read().then((doc) => {
    const page = attachmentDocAsPage(doc, title);
    if (!tab) return;
    if (page) tab.location.href = URL.createObjectURL(page);
    else tab.close();
  }).catch(() => tab?.close());
}
