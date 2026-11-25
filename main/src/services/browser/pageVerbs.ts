import { type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { BrowserPageContents, FileChooser, LoginToFill, PageDriver, PendingDialog } from './pageDriver';

/** One browser tool's work on a tab's page, after the caller, tab and arguments are checked. */
export type VerbRequest =
  | { verb: 'snapshot' }
  | { verb: 'screenshot'; fullPage: boolean }
  | { verb: 'click'; ref?: string; x?: number; y?: number; button: 'left' | 'right' | 'middle'; double: boolean }
  | { verb: 'type'; ref: string; text: string; clear: boolean; submit: boolean }
  | { verb: 'fill'; ref: string; login: LoginToFill }
  | { verb: 'press'; key: string; ref?: string }
  | { verb: 'select'; ref: string; values: string[] }
  | { verb: 'scroll'; ref?: string; dx: number; dy: number }
  | { verb: 'navigate'; url?: string; history?: 'back' | 'forward' | 'reload' }
  | { verb: 'wait'; text?: string; url?: string; ref?: string; timeoutMs: number }
  | { verb: 'dialog'; accept: boolean; text?: string }
  | { verb: 'evaluate'; expression: string; ref?: string }
  | { verb: 'upload'; ref?: string; paths: string[] };

/** Reads never wait for the person and may run on any tab of the Pane. */
export const READ_VERBS: ReadonlySet<VerbRequest['verb']> = new Set(['snapshot', 'screenshot', 'wait']);

/** What a verb did, as plain JSON, plus a screenshot's PNG when it took one. */
export interface VerbOutcome {
  url: string;
  title: string;
  dialog?: PendingDialog;
  fileChooser?: FileChooser;
  note?: string;
  snapshot?: string;
  truncated?: boolean;
  value?: JsonValue;
  /** The site a saved login was filled on. */
  filledSite?: string;
  /** Where a click landed, for the agent's cursor on the tab. */
  cursor?: { x: number; y: number };
  image?: { png: Buffer; width: number; height: number };
}

const DIALOG_NOTE = 'The page opened a dialog and is blocked until it is answered. Answer it with browser_dialog.';
const CHOOSER_NOTE = 'The page opened a file picker. Fill it with browser_upload and --paths, leaving --ref out.';

/** Runs one verb on a page through its driver. */
export async function runVerb(page: PageDriver, contents: BrowserPageContents, request: VerbRequest): Promise<VerbOutcome> {
  const after = (extra: Partial<VerbOutcome> & { dialog?: PendingDialog; fileChooser?: FileChooser } = {}): VerbOutcome => {
    const outcome: VerbOutcome = { url: contents.getURL(), title: contents.getTitle(), ...extra };
    if (extra.dialog) outcome.note = DIALOG_NOTE;
    if (extra.fileChooser) outcome.note = CHOOSER_NOTE;
    const notice = page.takeNotice();
    if (notice) outcome.note = [notice, outcome.note].filter(Boolean).join(' ');
    return outcome;
  };
  switch (request.verb) {
    case 'snapshot': {
      const reading = await page.snapshot();
      const outcome: VerbOutcome = { url: reading.url, title: reading.title, snapshot: reading.snapshot };
      if (reading.truncated) {
        outcome.truncated = true;
        outcome.note = reading.controlsCut
          ? 'The page is very long, so its later text and its controls past about 60,000 characters were left out. Use browser_evaluate to find them, or browser_click with x and y.'
          : 'The page is long, so text past the limit was left out; every control on the page still has a ref. Use browser_evaluate to read the rest of the text.';
      }
      return outcome;
    }
    case 'screenshot':
      return after({ image: await page.screenshot(request.fullPage) });
    case 'click': {
      const target = request.ref !== undefined ? { ref: request.ref } : { x: request.x ?? 0, y: request.y ?? 0 };
      const { x, y, ...clicked } = await page.click(target, request.button, request.double);
      const outcome = after(clicked);
      outcome.cursor = { x, y };
      return outcome;
    }
    case 'type':
      return after(await page.type(request.ref, request.text, request.clear, request.submit));
    case 'fill': {
      const { site, sure, ...filled } = await page.fill(request.ref, request.login);
      const outcome = after(filled);
      outcome.filledSite = site;
      const what = sure ? `Filled ${request.login.key}.` : `The page changed while Pane filled ${request.login.key}, so it may hold it, part of it or nothing: a page that submits by itself does this. Call browser_snapshot to see where it is.`;
      outcome.note = [`${what} Its value shows as dots, and scripts don't run on this page until the tab loads a new one.`, outcome.note].filter(Boolean).join(' ');
      return outcome;
    }
    case 'press':
      return after(await page.press(request.key, request.ref));
    case 'select': {
      const selected = await page.select(request.ref, request.values);
      return after({ note: `Selected: ${selected.join(', ')}` });
    }
    case 'scroll':
      await page.scroll(request.ref, request.dx, request.dy);
      return after();
    case 'navigate':
      await page.navigate(request.url !== undefined ? { url: request.url } : { history: request.history ?? 'reload' });
      return after();
    case 'wait': {
      const { verb: _verb, timeoutMs, ...conditions } = request;
      await page.wait(conditions, timeoutMs);
      return page.pendingDialog ? after({ dialog: page.pendingDialog }) : after();
    }
    case 'dialog': {
      const answered = await page.answerDialog(request.accept, request.text);
      return after({ note: `${request.accept ? 'Accepted' : 'Dismissed'} the ${answered.type} "${answered.message.slice(0, 120)}".` });
    }
    case 'evaluate': {
      const { value, truncated } = await page.evaluate(request.expression, request.ref);
      if (!truncated) return after({ value });
      return after({ value, truncated: true, note: 'The value was over 64 KB, so it is cut off: value holds the start of its JSON text. Return less, such as one field or a slice.' });
    }
    case 'upload':
      await page.upload(request.ref, request.paths);
      return after({ note: `Set ${request.paths.map(file => file.split(/[\\/]/).pop()).join(', ')}.` });
  }
}
