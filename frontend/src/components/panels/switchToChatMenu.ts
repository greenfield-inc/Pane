import { MessageSquare, ToggleRight } from 'lucide-react';
import type { ChatAgentEntry } from '../../../../shared/types/chatTab';
import type { ToolPanel } from '../../../../shared/types/panels';
import { terminalChatSwitch } from '../../utils/agentTerminal';
import { turnOnChatTabsHere } from '../../utils/sessionChatSwitch';
import type { DropdownItem } from '../ui/Dropdown';

/**
 * Switch to chat in an agent tab's right-click menu, always shown for a tab running an agent the
 * host's catalog lists: it opens the dialog, or is disabled with why not (already a chat; chat tabs
 * off, with Turn on; the agent's own reason). Nothing for any other tab.
 */
export function switchToChatMenuItems(panel: ToolPanel, chatTabsEnabled: boolean, agents: readonly ChatAgentEntry[] | undefined, onOpen: () => void): DropdownItem[] {
  const item = { id: 'switch-to-chat', label: 'Switch to chat…', icon: MessageSquare };
  if (panel.type === 'chat') return [{ ...item, disabled: true, description: 'This tab is already a chat' }];
  const canSwitch = terminalChatSwitch(panel, agents);
  if (!canSwitch) return [];
  if (!chatTabsEnabled) return [
    { ...item, disabled: true, description: 'Chat tabs are off on this machine' },
    // Closes the menu: left open, it would shrink and slide Close tab under the pointer.
    { id: 'turn-on-chat-tabs', label: 'Turn on chat tabs', icon: ToggleRight, onClick: () => void turnOnChatTabsHere() },
  ];
  if (!canSwitch.ok) return [{ ...item, disabled: true, description: canSwitch.reason }];
  return [{ ...item, onClick: onOpen }];
}
