import { boundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { BrowserPageContents, FileChooser, PageDriver, PendingDialog } from './pageDriver';

/**
 * One browser tool's work on a page, after the caller, tab and arguments are checked. The same
 * request runs on this computer's page or, over `runpane:machine:browser`, on the copy of the tab
 * a linked computer shows (docs/BROWSER_AGENTS.md), so it is plain JSON.
 */
export type VerbRequest =
  | { verb: 'snapshot' }
  | { verb: 'screenshot'; fullPage: boolean }
  | { verb: 'click'; ref?: string; x?: number; y?: number; button: 'left' | 'right' | 'middle'; double: boolean }
  | { verb: 'type'; ref: string; text: string; clear: boolean; submit: boolean }
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

const optionalString = boundary.optional(boundary.string);
export const verbRequestSchema: BoundarySchema<VerbRequest> = boundary.union(
  boundary.object({ verb: boundary.literal('snapshot') }),
  boundary.object({ verb: boundary.literal('screenshot'), fullPage: boundary.boolean }),
  boundary.object({ verb: boundary.literal('click'), ref: optionalString, x: boundary.optional(boundary.number), y: boundary.optional(boundary.number), button: boundary.enumeration('left', 'right', 'middle'), double: boundary.boolean }),
  boundary.object({ verb: boundary.literal('type'), ref: boundary.string, text: boundary.string, clear: boundary.boolean, submit: boundary.boolean }),
  boundary.object({ verb: boundary.literal('press'), key: boundary.string, ref: optionalString }),
  boundary.object({ verb: boundary.literal('select'), ref: boundary.string, values: boundary.array(boundary.string) }),
  boundary.object({ verb: boundary.literal('scroll'), ref: optionalString, dx: boundary.number, dy: boundary.number }),
  boundary.object({ verb: boundary.literal('navigate'), url: optionalString, history: boundary.optional(boundary.enumeration('back', 'forward', 'reload')) }),
  boundary.object({ verb: boundary.literal('wait'), text: optionalString, url: optionalString, ref: optionalString, timeoutMs: boundary.number }),
  boundary.object({ verb: boundary.literal('dialog'), accept: boundary.boolean, text: optionalString }),
  boundary.object({ verb: boundary.literal('evaluate'), expression: boundary.string, ref: optionalString }),
  boundary.object({ verb: boundary.literal('upload'), ref: optionalString, paths: boundary.array(boundary.string) }),
);

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
    return outcome;
  };
  switch (request.verb) {
    case 'snapshot': {
      const reading = await page.snapshot();
      const outcome: VerbOutcome = { url: reading.url, title: reading.title, snapshot: reading.snapshot };
      if (reading.truncated) {
        outcome.truncated = true;
        outcome.note = 'The page is long, so the snapshot was cut off. Scroll, or use browser_evaluate to read a part of it.';
      }
      return outcome;
    }
    case 'screenshot':
      return after({ image: await page.screenshot(request.fullPage) });
    case 'click': {
      const target = request.ref !== undefined ? { ref: request.ref } : { x: request.x ?? 0, y: request.y ?? 0 };
      const clicked = await page.click(target, request.button, request.double);
      const outcome = after(clicked);
      outcome.cursor = { x: clicked.x, y: clicked.y };
      return outcome;
    }
    case 'type':
      return after(await page.type(request.ref, request.text, request.clear, request.submit));
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
