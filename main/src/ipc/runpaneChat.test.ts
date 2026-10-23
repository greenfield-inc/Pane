import { afterEach, expect, it, vi } from 'vitest';
import { agentChatManager } from '../services/agentChat/agentChatManager';
afterEach(() => vi.restoreAllMocks());
import { assertRawTerminal } from './runpaneChat';

it.each(['chat', 'stopped'] as const)('shows a live native startup snapshot before %s ownership completes, then fences it after failure', mode => {
  vi.spyOn(agentChatManager, 'mode').mockReturnValue(mode);
  const starting = vi.spyOn(agentChatManager, 'isNativeStarting').mockReturnValue(true);
  expect(() => assertRawTerminal('panel')).not.toThrow();
  starting.mockReturnValue(false);
  expect(() => assertRawTerminal('panel')).toThrow(/No live native terminal/);
});
