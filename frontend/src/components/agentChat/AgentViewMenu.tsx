import { useEffect, useState, type ReactElement } from 'react';
import { MessageSquare, TerminalSquare } from 'lucide-react';
import type { AgentChatClient, AgentChatView, AgentInterface } from '../../../../shared/types/agentChat';
import { Dropdown } from '../ui/Dropdown';

/** The same menu is used by local tabs and remote viewers. All changes run on the host. */
export function AgentViewMenu({ panelId, title, client, trigger }: { panelId: string; title: string; client: AgentChatClient; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AgentChatView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [nativeId, setNativeId] = useState('');
  const [socketPath, setSocketPath] = useState('');
  const transitioning = !!view?.conversation?.transition && view.conversation.active !== 'stopped';
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void client.get(panelId).then(result => { if (!disposed) { setView(result); setError(undefined); } }, reason => { if (!disposed) setError(`Chat is unavailable on this host: ${String(reason)}`); });
    const detach = client.onState(result => { if (result.panelId === panelId) setView(result); });
    return () => { disposed = true; detach(); };
  }, [client, open, panelId]);
  const change = async (mode: AgentInterface) => {
    if (!view?.conversation) return;
    setBusy(true); setError(undefined);
    try {
      if (view.conversation.active === 'stopped') await client.recover(panelId, mode, view.conversation.generation);
      else await client.switch(panelId, mode, view.conversation.generation);
      setView(await client.get(panelId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const identify = async () => {
    if (!client.identify) return;
    setBusy(true); setError(undefined);
    try { setView(await client.identify(panelId, nativeId, socketPath)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <Dropdown formLabel={view?.identificationRequired ? 'Identify this Codex conversation' : undefined} className="contents" contextMenu menuLabel={`${title} actions`} width="lg" closeOnSelect={false} onOpenChange={setOpen} selectedId={view?.conversation?.active}
    trigger={trigger}
    items={view?.available ? [
      { id: 'terminal', label: 'View as Terminal', icon: TerminalSquare, disabled: busy || transitioning, onClick: () => void change('terminal') },
      { id: 'chat', label: 'View as Chat', icon: MessageSquare, disabled: busy || transitioning, onClick: () => void change('chat') },
    ] : []}
    footer={busy || !view || error || view.error || view.conversation?.recovery || view.identificationRequired ? <div className="max-w-64 whitespace-normal px-3 py-2 text-xs text-text-secondary">
      {view?.identificationRequired && <form className="space-y-2" onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
        const current = controls.findIndex(control => control === document.activeElement);
        const next = current + (event.shiftKey ? -1 : 1);
        if (current >= 0 && next >= 0 && next < controls.length) event.stopPropagation();
      }} onSubmit={event => { event.preventDefault(); void identify(); }}>
        <p>Run /status in this tab when its composer is ready. {view.identificationSocketRequired === false ? 'Enter its Session ID once; Pane will stop this embedded runtime and continue from its saved history.' : 'Enter its Session ID and server socket once; Pane remembers them.'}</p>
        <label className="block">Session ID<input aria-label="Codex Session ID" className="mt-1 w-full rounded border border-border-primary bg-surface-primary px-2 py-1 text-text-primary" value={nativeId} onChange={event => setNativeId(event.target.value)} disabled={busy} /></label>
        {view.identificationSocketRequired !== false && <label className="block">Server socket<input aria-label="Codex server socket" className="mt-1 w-full rounded border border-border-primary bg-surface-primary px-2 py-1 text-text-primary" value={socketPath} onChange={event => setSocketPath(event.target.value)} disabled={busy} /></label>}
        <button type="submit" disabled={busy || !nativeId.trim() || (view.identificationSocketRequired !== false && !socketPath.trim())} className="rounded px-2 py-1 text-interactive disabled:opacity-50">Connect conversation</button>
      </form>}
      {busy ? <p role="status">Switching interface…</p> : !view && !error ? <p role="status">Checking conversation…</p> : null}
      {view?.conversation?.recovery && <p role="status">{view.conversation.recovery}</p>}
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {!error && view?.error && <p role="alert" className="text-status-error">{view.error}</p>}
    </div> : undefined} />;
}
