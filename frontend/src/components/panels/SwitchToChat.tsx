import { useState } from 'react';
import type { ToolPanel } from '../../../../shared/types/panels';
import { isAgentTerminal } from '../../utils/agentTerminal';
import { isChatTabsEnabled, useConfigStore } from '../../stores/configStore';
import { useHotkey } from '../../hooks/useHotkey';
import { useNavigationStore } from '../../stores/navigationStore';
import { useErrorStore } from '../../stores/errorStore';
import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { SwitchToChatBody } from './SwitchToChatDialog';
import { switchFailure, type SwitchFailure } from './switchToChatCopy';

/** Whether Switch to chat is offered for this tab: chat tabs are on and it is a terminal Claude or Codex tab. */
function useCanSwitchToChat(panel: ToolPanel | undefined): boolean {
  return useConfigStore(state => isChatTabsEnabled(state.config)) && isAgentTerminal(panel);
}

/**
 * Switch to chat (D-129) for one tab: the terminal agent's conversation continues in a chat tab.
 * Opened from the tab's right-click menu or the command palette (D-229).
 */
export function SwitchToChatDialog({ panel, isOpen, onClose }: { panel: ToolPanel; isOpen: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SwitchFailure | null>(null);
  const close = () => { setError(null); onClose(); };
  const switchNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.chatTab.switch(panel.id);
      close();
      // The chat tab may already be in front, and this dialog goes with the terminal's tab: say why both stay app-wide.
      if (result.terminalKept && result.reason) useErrorStore.getState().showError({ title: 'Both tabs stayed open', error: result.reason });
    } catch (failure) {
      // After the stop, the code says whether the terminal is back on its conversation or stopped; Try again runs the switch again.
      setError(switchFailure(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!busy) close(); }} ariaLabel="Switch to chat">
      <ModalHeader title="Switch to chat" />
      <ModalBody>
        <SwitchToChatBody busy={busy} failure={error ?? undefined} />
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" disabled={busy} onClick={close}>{error ? 'Close' : 'Cancel'}</Button>
        <Button disabled={busy} onClick={() => void switchNow()}>{busy ? 'Switching…' : error ? 'Try again' : 'Switch to chat'}</Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * The command palette's Switch to chat, registered by one owner per view: the Pane's tab bar, or
 * the focused Session tile. Each view has its own ID, so another view never replaces or removes it.
 */
export function SwitchToChatPaletteEntry({ panel, view }: { panel: ToolPanel; view: 'pane' | 'session' }) {
  const [open, setOpen] = useState(false);
  if (!useCanSwitchToChat(panel)) return null;
  return <>
    <SwitchToChatCommand view={view} onOpen={() => setOpen(true)} />
    <SwitchToChatDialog panel={panel} isOpen={open} onClose={() => setOpen(false)} />
  </>;
}

function SwitchToChatCommand({ view, onOpen }: { view: 'pane' | 'session'; onOpen: () => void }) {
  const activeView = useNavigationStore(state => state.activeView);
  const showing = view === 'session' ? activeView === 'pane-chat' : activeView !== 'pane-chat';
  useHotkey({
    id: `switch-to-chat-${view}`,
    label: 'Switch to chat',
    keys: '',
    category: 'tabs',
    enabled: () => showing,
    action: onOpen,
    showInPalette: true,
  });
  return null;
}
