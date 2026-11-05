import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import { chatTurns } from '../../../../shared/chatTabPresentation';
import { conversationMarkdown, responseText, userMarkdown } from '../../../../shared/chatTabMarkdown';

const messages: AgentChatMessage[] = [
  { id: 'user:1', role: 'user', parts: [{ type: 'text', text: 'Why does `pnpm test` fail?' }] },
  { id: 'a1', role: 'assistant', parts: [
    { type: 'tool', id: 't1', title: 'Read package.json', kind: 'read', status: 'completed', locations: [{ path: '/repo/package.json' }] },
    { type: 'tool', id: 't2', title: 'pnpm test', kind: 'execute', status: 'failed', input: { command: 'pnpm test' }, terminal: 'FAIL src/a.test.ts\n'.repeat(200) },
    { type: 'text', text: 'The **`a.test.ts`** suite imports a file that moved.\n\n```ts\nimport { a } from "./a";\n```' },
  ] },
];

describe('a chat as Markdown (D-140)', () => {
  const [turn] = chatTurns(messages, { running: false });

  it('copies what the person wrote', () => {
    expect(userMarkdown(turn)).toBe('Why does `pnpm test` fail?');
  });

  it('copies a response as the agent\'s text only, without its activity lines (D-182)', () => {
    expect(responseText(turn)).toBe('The **`a.test.ts`** suite imports a file that moved.\n\n```ts\nimport { a } from "./a";\n```');
  });

  it('has nothing to copy for a response that is only activity', () => {
    const [stepsOnly] = chatTurns([messages[0], { id: 'a2', role: 'assistant', parts: [messages[1].parts[0]] }], { running: false });
    expect(responseText(stepsOnly)).toBe('');
  });

  it('copies the conversation under speaker labels', () => {
    const markdown = conversationMarkdown([turn], 'Claude');
    expect(markdown.startsWith('**You:**\n\nWhy does `pnpm test` fail?\n\n**Claude:**\n\n- Explored')).toBe(true);
    // The conversation keeps tool calls, compactly, and never their raw output.
    expect(markdown).toContain('- Ran `pnpm test` (failed)');
    expect(markdown).not.toContain('FAIL src/a.test.ts');
  });
});
