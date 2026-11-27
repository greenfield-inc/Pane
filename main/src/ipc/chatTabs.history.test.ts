import { describe, expect, it, vi } from 'vitest';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { ChatTabHistoryRead } from '../../../shared/types/chatTab';
import { historyAnswer } from './chatTabs';

describe('chat-tab:history (T-116 D-19)', () => {
  it('says earlier messages are not available yet when asked with withStatus, and answers the bare list otherwise', () => {
    const historyRead = vi.fn<(panelId: string, before: number, limit: number) => ChatTabHistoryRead>(() => ({ messages: [], unavailable: true }));
    const history = vi.fn<(panelId: string, before: number, limit: number) => AgentChatMessage[]>(() => []);
    const manager = { history, historyRead };

    expect(historyAnswer(manager, 'chat-1', 550, 100, { withStatus: true })).toEqual({ messages: [], unavailable: true });
    expect(historyRead).toHaveBeenCalledWith('chat-1', 550, 100);
    // An older desktop sends no fourth argument and gets the list it always did.
    expect(historyAnswer(manager, 'chat-1', 550, 100)).toEqual([]);
    expect(history).toHaveBeenCalledWith('chat-1', 550, 100);
  });
});
