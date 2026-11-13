import { expect, it } from 'vitest';
import { ipcErrorCode, ipcErrorMessage } from './ipcErrorMessage';
import { PaneError } from '../../../shared/paneError';
import { RemoteRequestError } from '../../../shared/remoteClient/remoteDaemonClient';

it('shows the backend reason instead of Electron\'s IPC wrapper', () => {
  const error = new Error("Error invoking remote method 'file:preview-action': Error: Reveal in folder works only on the host");
  expect(ipcErrorMessage(error, 'Unable to open file')).toBe('Reveal in folder works only on the host');
  expect(ipcErrorMessage(new Error("Error invoking remote method 'file:preview-action': "), 'Unable to open file')).toBe('Unable to open file');
});

it('reads a failed response\'s error string, and falls back when there is no reason', () => {
  expect(ipcErrorMessage('Worktree is locked by another Pane', 'Pane did not say why.')).toBe('Worktree is locked by another Pane');
  expect(ipcErrorMessage(undefined, 'Pane did not say why.')).toBe('Pane did not say why.');
});

it('reads a PaneError code from Electron\'s wrapper and keeps it out of the shown reason', () => {
  const error = new Error("Error invoking remote method 'daemon:invoke': Error [CHAT_SWITCH_FAILED]: The chat agent didn't start within 60 seconds. The terminal is back on the same conversation (0a432b9d), with its history.");
  expect(ipcErrorCode(error)).toBe('CHAT_SWITCH_FAILED');
  expect(ipcErrorMessage(error, 'Could not switch.')).toBe("The chat agent didn't start within 60 seconds. The terminal is back on the same conversation (0a432b9d), with its history.");
});

it('reads the code a remote client error carries, and none from a plain one', () => {
  expect(ipcErrorCode(new PaneError('CHAT_SWITCH_NOT_STARTED', 'Refused'))).toBe('CHAT_SWITCH_NOT_STARTED');
  expect(ipcErrorCode(new RemoteRequestError('Refused', 409, 'CHAT_RESUME_BUSY'))).toBe('CHAT_RESUME_BUSY');
  expect(ipcErrorCode(new Error("Error invoking remote method 'chat-tab:switch': Error: Busy"))).toBeUndefined();
  expect(ipcErrorCode('Busy')).toBeUndefined();
});
