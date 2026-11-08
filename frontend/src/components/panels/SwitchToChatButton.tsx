import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { ToolPanel, TerminalPanelState } from '../../../../shared/types/panels';
import { isChatTabsEnabled, useConfigStore } from '../../stores/configStore';
import { useHotkey } from '../../hooks/useHotkey';
import { useNavigationStore } from '../../stores/navigationStore';
import { useErrorStore } from '../../stores/errorStore';
import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { SwitchToChatBody } from './SwitchToChatDialog';
import { switchFailure, type SwitchFailure } from './switchToChatCopy';

/** Whether a tab is a terminal running Claude or Codex, the agents a chat tab can run. */
function canSwitchToChat(panel: ToolPanel | undefined): panel is ToolPanel {
  // SAFETY: terminal panels persist TerminalPanelState as their custom state.
  const agent = panel?.type === 'terminal' ? (panel.state.customState as TerminalPanelState | undefined)?.agentType : undefined;
  return agent === 'claude' || agent === 'codex';
}

/**
 * The palette entry, registered by one owner per view: the Pane's tab bar, or the focused
 * Session tile. Each view has its own ID, so another view's button never replaces or removes it.
 */
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

/**
 * Switch to chat (D-129): the terminal agent's conversation continues in a chat tab. A button
 * beside the tab's other actions and, from `palette`'s owner, a command palette entry; shown
 * only with chat tabs on.
 */
export function SwitchToChatButton({ panel, className, palette }: { panel: ToolPanel; className?: string; palette?: 'pane' | 'session' }) {
  const enabled = useConfigStore(state => isChatTabsEnabled(state.config)) && canSwitchToChat(panel);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SwitchFailure | null>(null);

  if (!enabled) return null;

  const close = () => { setOpen(false); setError(null); };
  const switchNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.chatTab.switch(panel.id);
      close();
      // The chat tab may already be in front, and this button goes with the terminal's tab: say why both stay app-wide.
      if (result.terminalKept && result.reason) useErrorStore.getState().showError({ title: 'Both tabs stayed open', error: result.reason });
    } catch (failure) {
      // After the stop, the code says whether the terminal is back on its conversation or stopped; Try again runs the switch again.
      setError(switchFailure(failure));
    } finally {
      setBusy(false);
    }
  };
  return <>
    {palette && <SwitchToChatCommand view={palette} onOpen={() => setOpen(true)} />}
    <button type="button" title="Switch to chat" aria-label="Switch to chat" className={className ?? 'p-2 rounded text-text-secondary hover:bg-surface-hover'} onClick={() => setOpen(true)}>
      <MessageSquare className="h-4 w-4" aria-hidden="true" />
    </button>
    <Modal isOpen={open} onClose={() => { if (!busy) close(); }} ariaLabel="Switch to chat">
      <ModalHeader title="Switch to chat" />
      <ModalBody>
        <SwitchToChatBody busy={busy} failure={error ?? undefined} />
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" disabled={busy} onClick={close}>{error ? 'Close' : 'Cancel'}</Button>
        <Button disabled={busy} onClick={() => void switchNow()}>{busy ? 'Switching…' : error ? 'Try again' : 'Switch to chat'}</Button>
      </ModalFooter>
    </Modal>
  </>;
}
