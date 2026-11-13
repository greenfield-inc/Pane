import { describe, expect, it } from 'vitest';
import { clientShowsChatTab } from './panels';

describe('which chat tabs a client is shown (P4)', () => {
  it('shows a client from before the agent catalog only the chat tabs its decoder accepts', () => {
    // Released phones decode a chat tab's agent as exactly "claude" or "codex".
    expect(clientShowsChatTab({ chatTabs: true }, 'claude')).toBe(true);
    expect(clientShowsChatTab({ chatTabs: true }, 'codex')).toBe(true);
    expect(clientShowsChatTab({ chatTabs: true }, 'cursor')).toBe(false);
    expect(clientShowsChatTab({ chatTabs: true }, 'gemini')).toBe(false);
  });

  it('shows a client that reads the catalog every chat tab, and a client without chat tabs none', () => {
    expect(clientShowsChatTab({ chatTabs: true, chatAgents: true }, 'cursor')).toBe(true);
    expect(clientShowsChatTab({ chatTabs: true, chatAgents: true }, 'gemini')).toBe(true);
    expect(clientShowsChatTab(undefined, 'claude')).toBe(false);
  });
});
