import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwitchToChatBody } from './SwitchToChatDialog';
import { SWITCH_TO_CHAT_CONFIRMATION, switchFailure } from './switchToChatCopy';

const wrapped = (code: string, message: string) => new Error(`Error invoking remote method 'daemon:invoke': Error [${code}]: ${message}`);

describe('Switch to chat dialog (D-282)', () => {
  it('asks with one plain confirmation for every switch', () => {
    expect(SWITCH_TO_CHAT_CONFIRMATION).toBe('Continue this conversation in a chat tab. Pane stops the terminal agent and opens its conversation in chat, with its history. If Pane isn\'t sure which conversation the terminal is on, it opens the most recent one in this folder, and you can pick another.');
    const html = renderToStaticMarkup(<SwitchToChatBody busy={false} />);
    expect(html).toContain('If Pane isn&#x27;t sure which conversation the terminal is on, it opens the most recent one in this folder, and you can pick another.');
    expect(html).not.toContain('role="alert"');
  });

  it('titles a failure after the stop by its code, with the host\'s message as the body', () => {
    expect(switchFailure(wrapped('CHAT_SWITCH_FAILED', 'The chat agent didn\'t start within 60 seconds. The terminal is back on the same conversation (0a432b9d), with its history.')))
      .toEqual({ title: 'The chat couldn\'t open it', message: 'The chat agent didn\'t start within 60 seconds. The terminal is back on the same conversation (0a432b9d), with its history.' });
    expect(switchFailure(wrapped('CHAT_SWITCH_NOT_STARTED', 'The chat agent didn\'t start within 60 seconds. The terminal is stopped, because Pane wasn\'t sure which conversation to restart it on. Your conversations are saved.')))
      .toEqual({ title: 'The chat couldn\'t start', message: 'The chat agent didn\'t start within 60 seconds. The terminal is stopped, because Pane wasn\'t sure which conversation to restart it on. Your conversations are saved.' });
  });

  it('shows any other failure as today: its message and next step, no title', () => {
    expect(switchFailure(wrapped('CHAT_TABS_DISABLED', 'Chat tabs are off. Next: Turn them on in Settings.'))).toEqual({ message: 'Chat tabs are off. Next: Turn them on in Settings.' });
    expect(switchFailure(new Error("Error invoking remote method 'daemon:invoke': Error: Busy"))).toEqual({ message: 'Busy' });
  });

  it('renders a titled failure as the alert card under the confirmation', () => {
    const html = renderToStaticMarkup(<SwitchToChatBody busy={false} failure={{ title: 'The chat couldn\'t start', message: 'It timed out.' }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('The chat couldn&#x27;t start');
    expect(html).toContain('It timed out.');
    expect(html).toContain('Continue this conversation in a chat tab.');
  });
});
