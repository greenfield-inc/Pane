import { MessageSquare, ToggleRight } from 'lucide-react';
import type { ToolPanel } from '../../../../shared/types/panels';
import { isAgentTerminal } from '../../utils/agentTerminal';
import { turnOnChatTabsHere } from '../../utils/sessionChatSwitch';
import type { DropdownItem } from '../ui/Dropdown';

/**
 * Switch to chat in an agent tab's right-click menu, always shown for a Claude or Codex tab: it
 * opens the dialog, or is disabled with why not (already a chat; chat tabs off, with Turn on).
 * Nothing for any other tab.
 */
export function switchToChatMenuItems(panel: ToolPanel, chatTabsEnabled: boolean, onOpen: () => void): DropdownItem[] {
  const item = { id: 'switch-to-chat', label: 'Switch to chat…', icon: MessageSquare };
  if (panel.type === 'chat') return [{ ...item, disabled: true, description: 'This tab is already a chat' }];
  if (!isAgentTerminal(panel)) return [];
  if (chatTabsEnabled) return [{ ...item, onClick: onOpen }];
  return [
    { ...item, disabled: true, description: 'Chat tabs are off on this machine' },
    // Closes the menu: left open, it would shrink and slide Close tab under the pointer.
    { id: 'turn-on-chat-tabs', label: 'Turn on chat tabs', icon: ToggleRight, onClick: () => void turnOnChatTabsHere() },
  ];
}
