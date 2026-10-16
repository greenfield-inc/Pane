import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANE_CHAT_AGENT,
  PANE_CHAT_CODEX_PANEL_ID,
  PANE_CHAT_CURSOR_PANEL_ID,
  PANE_CHAT_PANEL_ID,
  getPaneChatPanelId,
  normalizePaneChatAgent,
} from '../../../shared/types/paneChat';

describe('normalizePaneChatAgent', () => {
  it('accepts every supported agent and defaults everything else', () => {
    expect(normalizePaneChatAgent('claude')).toBe('claude');
    expect(normalizePaneChatAgent('codex')).toBe('codex');
    expect(normalizePaneChatAgent('cursor')).toBe('cursor');
    expect(normalizePaneChatAgent('opencode')).toBe('opencode');
    expect(normalizePaneChatAgent('aider')).toBe(DEFAULT_PANE_CHAT_AGENT);
    expect(normalizePaneChatAgent('constructor')).toBe(DEFAULT_PANE_CHAT_AGENT);
    expect(normalizePaneChatAgent('toString')).toBe(DEFAULT_PANE_CHAT_AGENT);
    expect(normalizePaneChatAgent('__proto__')).toBe(DEFAULT_PANE_CHAT_AGENT);
    expect(normalizePaneChatAgent(undefined)).toBe(DEFAULT_PANE_CHAT_AGENT);
  });
});

describe('getPaneChatPanelId', () => {
  it('maps each agent to a distinct permanent panel id', () => {
    expect(getPaneChatPanelId('claude')).toBe(PANE_CHAT_PANEL_ID);
    expect(getPaneChatPanelId('codex')).toBe(PANE_CHAT_CODEX_PANEL_ID);
    expect(getPaneChatPanelId('cursor')).toBe(PANE_CHAT_CURSOR_PANEL_ID);
    expect(getPaneChatPanelId('opencode')).toBe('__pane_chat_terminal_opencode__');
    const ids = [PANE_CHAT_PANEL_ID, PANE_CHAT_CODEX_PANEL_ID, PANE_CHAT_CURSOR_PANEL_ID, getPaneChatPanelId('opencode')];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
