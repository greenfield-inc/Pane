import { useEffect, useState } from 'react';
import type { ToolPanel } from '../../../shared/types/panels';
import { panelApi } from '../services/panelApi';
import { PromoteChatButton } from './panels/PromoteChatButton';
import { Modal, ModalBody, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';

export function PromotePaneDialog({ paneId, paneName, onClose }: { paneId: string; paneName: string; onClose: () => void }) {
  const [panels, setPanels] = useState<ToolPanel[] | null>(null);
  const [selected, setSelected] = useState<ToolPanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void panelApi.loadPanelsForSession(paneId).then(items => {
      if (disposed) return;
      const chats = items.filter(panel => panel.type === 'terminal' && panel.state.customState && 'agentType' in panel.state.customState && panel.state.customState.agentType);
      setPanels(chats);
      if (chats.length === 1) setSelected(chats[0]);
    }).catch(() => { if (!disposed) setError('Could not load chats. Close this dialog and try again.'); });
    return () => { disposed = true; };
  }, [paneId]);
  if (selected) return <PromoteChatButton panel={selected} paneName={paneName} initiallyOpen onClose={onClose} />;
  return <Modal isOpen onClose={onClose} ariaLabel="Choose chat to promote">
    <ModalHeader title="Move chat to Session" />
    <ModalBody>
      {error ? <p role="alert">{error}</p> : panels === null ? <p>Loading chats…</p> : panels.length === 0 ? <p>Open an agent chat in this worktree first.</p> : <>
        <p className="mb-3 text-sm text-text-secondary">Choose the conversation to move. Other tabs stay in the worktree.</p>
        {panels.map(panel => <Button key={panel.id} variant="secondary" onClick={() => setSelected(panel)}>{panel.title}</Button>)}
      </>}
    </ModalBody>
  </Modal>;
}
