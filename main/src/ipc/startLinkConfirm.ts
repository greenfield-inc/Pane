import { randomUUID } from 'crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { configuredAgentSchema } from '../../../shared/agents';
import { START_LINK_ANSWER_CHANNEL, START_LINK_REQUEST_CHANNEL, type StartLinkAnswer, type StartLinkRequest } from '../../../shared/types/startLinks';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

type Answer = Omit<StartLinkAnswer, 'requestId'>;

const answerSchema = boundary.object({
  requestId: boundary.string,
  start: boundary.boolean,
  agent: boundary.optional(configuredAgentSchema),
  target: boundary.optional(boundary.number),
});

const CANCEL: Answer = { start: false };

/**
 * Asks the person about a `pane://new` link in Pane's own window and waits for their answer. Only
 * the main window may answer, and only the request it was shown; a reload, a crash or a closed
 * window counts as Cancel, so nothing else can press Start.
 */
export function registerStartLinkConfirm(ipcMain: Pick<IpcMain, 'handle'>, raiseMainWindow: () => BrowserWindow | undefined) {
  let pending: { requestId: string; window: BrowserWindow; settle: (answer: Answer) => void } | null = null;

  ipcMain.handle(START_LINK_ANSWER_CHANNEL, (event: IpcMainInvokeEvent, value: unknown) => {
    if (!pending || event.sender !== pending.window.webContents) return;
    let answer: StartLinkAnswer;
    try {
      answer = decodeBoundary(value, answerSchema);
    } catch {
      return;
    }
    if (answer.requestId !== pending.requestId) return;
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
    const settle = (answer: Answer) => {
      if (pending?.requestId !== requestId) return;
      pending = null;
      window.removeListener('closed', cancel);
      contents.removeListener('render-process-gone', cancel);
      contents.removeListener('did-start-loading', cancel);
      resolve(answer);
    };
    pending = { requestId, window, settle };
    window.once('closed', cancel);
    contents.once('render-process-gone', cancel);
    // A reload drops the dialog.
    contents.once('did-start-loading', cancel);
    contents.send(START_LINK_REQUEST_CHANNEL, { ...request, requestId });
  });
}
