import { useState } from 'react';
import type { ToolPanel } from '../../../../shared/types/panels';
import { isAgentTerminal } from '../../utils/agentTerminal';
import { isChatTabsEnabled, useConfigStore } from '../../stores/configStore';
import { useHotkey } from '../../hooks/useHotkey';
import { useNavigationStore } from '../../stores/navigationStore';
import { useErrorStore } from '../../stores/errorStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';

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
  const [error, setError] = useState<string | null>(null);
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
      setError(ipcErrorMessage(failure, 'Could not switch to chat.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!busy) close(); }} ariaLabel="Switch to chat">
      <ModalHeader title="Switch to chat" />
      <ModalBody>
        <p className="text-sm text-text-secondary">
          Continue this conversation in a chat tab. Pane stops the terminal agent and reopens the same conversation in chat, with its history. If it can&apos;t, you&apos;ll see why, and the terminal comes back running the same conversation.
        </p>
        {busy && <p role="status" className="mt-3 text-sm text-text-tertiary">Switching…</p>}
        {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
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
    category: 'tabs',
    enabled: () => showing,
    action: onOpen,
    showInPalette: true,
  });
  return null;
}
