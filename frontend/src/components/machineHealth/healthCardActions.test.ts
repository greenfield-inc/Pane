import { describe, expect, it } from 'vitest';
import { decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { askAgentReplySchema } from './healthCardActions';

describe('the Ask an agent reply', () => {
  it('names the Session a current host started', () => {
    expect(decodeBoundary({ sessionId: 'clean-up', panelId: 'panel-1', typed: true }, askAgentReplySchema)).toEqual({ sessionId: 'clean-up' });
  });

  it('accepts an older host\'s reply, which names only the Pane Chat panel it typed into (F-2)', () => {
    expect(decodeBoundary({ panelId: '__pane_chat_terminal__' }, askAgentReplySchema)).toEqual({ sessionId: undefined });
  });

  it('still refuses an empty sessionId', () => {
    expect(() => decodeBoundary({ sessionId: '' }, askAgentReplySchema)).toThrow();
  });
});
