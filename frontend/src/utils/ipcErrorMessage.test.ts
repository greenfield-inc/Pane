import { expect, it } from 'vitest';
import { ipcErrorMessage } from './ipcErrorMessage';

it('shows the backend reason instead of Electron\'s IPC wrapper', () => {
  const error = new Error("Error invoking remote method 'file:preview-action': Error: Reveal in folder works only on the host");
  expect(ipcErrorMessage(error, 'Unable to open file')).toBe('Reveal in folder works only on the host');
  expect(ipcErrorMessage(new Error("Error invoking remote method 'file:preview-action': "), 'Unable to open file')).toBe('Unable to open file');
});
