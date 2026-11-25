import { randomUUID } from 'crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { configuredAgentSchema } from '../../../shared/agents';
import { START_LINK_ANSWER_CHANNEL, START_LINK_PENDING_CHANNEL, START_LINK_REQUEST_CHANNEL, type StartLinkAnswer, type StartLinkRequest } from '../../../shared/types/startLinks';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

type Answer = Omit<StartLinkAnswer, 'requestId'>;

const answerSchema = boundary.object({
  requestId: boundary.string,
  start: boundary.boolean,
  agent: boundary.optional(configuredAgentSchema),
  target: boundary.optional(boundary.number),
});

const CANCEL: Answer = { start: false };

/** Electron's `did-start-navigation` arguments the question reads. */
type Navigation = (event: Electron.Event, url: string, isInPlace: boolean, isMainFrame: boolean) => void;

/** The parts of Pane's main window the question uses. */
interface ConfirmWindow {
  once(event: 'closed', listener: () => void): void;
  removeListener(event: 'closed', listener: () => void): void;
  webContents: {
    send(channel: string, request: StartLinkRequest): void;
    once(event: 'render-process-gone', listener: () => void): void;
    on(event: 'did-start-navigation', listener: Navigation): void;
    removeListener(event: 'render-process-gone', listener: () => void): void;
    removeListener(event: 'did-start-navigation', listener: Navigation): void;
  };
}

/**
 * Asks the person about a `pane://new` link in Pane's own window and waits for their answer. Only
 * the main window may answer, and only the request it was shown; a reload, a crash or a closed
 * window counts as Cancel, so nothing else can press Start.
 */
export function registerStartLinkConfirm(ipcMain: Pick<IpcMain, 'handle'>, raiseMainWindow: () => ConfirmWindow | undefined) {
  let pending: { request: StartLinkRequest; window: ConfirmWindow; settle: (answer: Answer) => void } | null = null;

  // The dialog asks on mount, so a request sent before the renderer listened is still shown.
  ipcMain.handle(START_LINK_PENDING_CHANNEL, (event: IpcMainInvokeEvent) =>
    pending && event.sender === pending.window.webContents ? pending.request : null);

  ipcMain.handle(START_LINK_ANSWER_CHANNEL, (event: IpcMainInvokeEvent, value: JsonValue) => {
    if (!pending || event.sender !== pending.window.webContents) return;
    let answer: StartLinkAnswer;
    try {
      answer = decodeBoundary(value, answerSchema);
    } catch {
      return;
    }
    if (answer.requestId !== pending.request.requestId) return;
    pending.settle({ start: answer.start, agent: answer.agent, target: answer.target });
  });

  return (request: Omit<StartLinkRequest, 'requestId'>): Promise<Answer> => new Promise((resolve) => {
    const window = raiseMainWindow();
    if (!window) {
      resolve(CANCEL);
      return;
    }
    const requestId = randomUUID();
    const contents = window.webContents;
    const cancel = () => settle(CANCEL);
    // A reload of the window drops the dialog; a frame inside the page (an iframe) loading does not.
    const navigated: Navigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) cancel();
    };
    const settle = (answer: Answer) => {
      if (pending?.request.requestId !== requestId) return;
      pending = null;
      window.removeListener('closed', cancel);
      contents.removeListener('render-process-gone', cancel);
      contents.removeListener('did-start-navigation', navigated);
      resolve(answer);
    };
    const shown: StartLinkRequest = { ...request, requestId };
    pending = { request: shown, window, settle };
    window.once('closed', cancel);
    contents.once('render-process-gone', cancel);
    contents.on('did-start-navigation', navigated);
    contents.send(START_LINK_REQUEST_CHANNEL, shown);
  });
}
