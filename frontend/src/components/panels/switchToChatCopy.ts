import { ipcErrorCode, ipcErrorMessage } from '../../utils/ipcErrorMessage';

/** The one confirmation every Switch to chat shows (D-282): nothing is checked before it. */
export const SWITCH_TO_CHAT_CONFIRMATION = 'Continue this conversation in a chat tab. Pane stops the terminal agent and opens its conversation in chat, with its history. If Pane isn\'t sure which conversation the terminal is on, it opens the most recent one in this folder, and you can pick another.';

/**
 * A switch that failed after the terminal stopped, by the host's code. The host's message
 * says what became of the terminal; the title says what became of the chat.
 */
function failureTitle(code: string | undefined): string | undefined {
  switch (code) {
    // Pane was sure of the conversation: the terminal is back on it.
    case 'CHAT_SWITCH_FAILED': return 'The chat couldn\'t open it';
    // Pane was not sure: the terminal stays stopped.
    case 'CHAT_SWITCH_NOT_STARTED': return 'The chat couldn\'t start';
    default: return undefined;
  }
}

export interface SwitchFailure { title?: string; message: string }

/** What the dialog shows for a failed switch. Any other code failed before the stop and changed nothing: its message (and next step) as before. */
export function switchFailure(cause: unknown): SwitchFailure {
  const message = ipcErrorMessage(cause, 'Could not switch to chat.');
  const title = failureTitle(ipcErrorCode(cause));
  return title ? { title, message } : { message };
}
