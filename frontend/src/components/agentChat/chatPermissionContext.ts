import { createContext } from 'react';
import type { AgentChatPermission } from '../../../../shared/types/agentChat';

export const ChatPermissionContext = createContext<{
  permissions: AgentChatPermission[];
  disabled: boolean;
  onAnswer: (request: AgentChatPermission, optionId: string) => Promise<void>;
}>({ permissions: [], disabled: true, onAnswer: async () => undefined });

