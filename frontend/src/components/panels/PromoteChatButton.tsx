import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { ToolPanel, TerminalPanelState } from '../../../../shared/types/panels';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useConfigStore } from '../../stores/configStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';

export function PromoteChatButton({ panel, paneName, initiallyOpen = false, onClose }: { panel: ToolPanel; paneName?: string; initiallyOpen?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(initiallyOpen);
  const close = () => { setOpen(false); onClose?.(); };
  const [name, setName] = useState(paneName || panel.title);
  const progressEnabled = useConfigStore(state => state.config?.experimentalSessionProgress === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // SAFETY: Terminal panels persist launch metadata in TerminalPanelState.
  const state = panel.state.customState as TerminalPanelState | undefined;
  if (panel.type !== 'terminal' || !state?.agentType || state.orchestrationSessionId) return null;

  const promote = async () => {
    setBusy(true);
    setError(null);
    try {
      const result: { success: boolean; error?: string } = await window.electronAPI.invoke('orchestration-sessions:promote', { panelId: panel.id, name: name.trim() });
      if (!result.success) throw new Error(result.error || 'Could not move chat');
      await useOrchestrationSessionStore.getState().refresh({ adoptServerSelection: true });
      await useSessionStore.getState().setActiveSession(null);
      useNavigationStore.getState().navigateToPaneChat();
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not move chat');
    } finally {
      setBusy(false);
    }
  };

  return <>
    {!initiallyOpen && <button type="button" title="Move chat to Session" aria-label="Move chat to Session" className="p-2 rounded text-text-secondary hover:bg-surface-hover" onClick={() => { setName(paneName || panel.title); setOpen(true); }}>
      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
    </button>}
    <Modal isOpen={open} onClose={() => { if (!busy) close(); }} ariaLabel="Move chat to Session">
      <ModalHeader title="Move chat to Session" />
      <ModalBody>
        <p className="mb-4 text-sm text-text-secondary">Resume this conversation in a Session with its own terminal{progressEnabled ? ', files, and progress view' : ' and files'}. Your worktree becomes a child; its files and changes stay where they are. Wait for the agent to finish first. Currently supports saved Claude and Codex chats.</p>
        <Input label="Session name" value={name} onChange={event => setName(event.target.value)} disabled={busy} fullWidth />
        {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
        <Button disabled={busy || !name.trim()} onClick={() => void promote()}>{busy ? 'Moving…' : 'Move chat'}</Button>
      </ModalFooter>
    </Modal>
  </>;
}
