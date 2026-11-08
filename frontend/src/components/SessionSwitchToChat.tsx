import { useEffect, useState } from 'react';
import type { SessionChatSwitchItem, SessionChatSwitchPreview, SessionChatSwitchResult } from '../../../shared/types/chatTab';
import { isChatTabsEnabled, useConfigStore } from '../stores/configStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { previewSessionChatSwitch, runSessionChatSwitch, skipLabel, summarizeSessionSwitch, switchable, type SessionSwitchWhere } from '../utils/sessionChatSwitch';
import { Button } from './ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';

/**
 * What switching this Session to chat would do, read when its menu opens (`sessionId` set) so the
 * menu offers Switch to chat only when some tab can switch. Null while reading, when it cannot be
 * read, or when nothing can switch. Here, chat tabs off means nothing can; another machine decides
 * that itself.
 */
export function useSessionSwitchPreview(where: SessionSwitchWhere, sessionId: string | null): SessionChatSwitchPreview | null {
  const chatTabsHere = useConfigStore(state => isChatTabsEnabled(state.config));
  const machineId = where.kind === 'machine' ? where.machineId : null;
  const [preview, setPreview] = useState<SessionChatSwitchPreview | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!sessionId || (machineId === null && !chatTabsHere)) return;
    let current = true;
    previewSessionChatSwitch(machineId === null ? { kind: 'here' } : { kind: 'machine', machineId }, sessionId)
      .then(read => { if (current && switchable(read.items).length > 0) setPreview(read); })
      // An older host has no preview: the menu just leaves the item out.
      .catch(error => console.warn('[SwitchToChat] Could not read what the Session would switch:', error));
    return () => { current = false; };
  }, [chatTabsHere, machineId, sessionId]);
  return preview;
}

function TabRow({ item, detail }: { item: SessionChatSwitchItem; detail?: string }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <span className="text-sm text-text-primary"><span className="text-text-tertiary">{item.paneName} · </span>{item.title}</span>
      {detail && <span className="text-xs text-text-tertiary">{detail}</span>}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{title}</h3>
      <ul className="divide-y divide-border-primary">{children}</ul>
    </section>
  );
}

/**
 * Switch to chat for a whole Session (D-229): lists what will switch and what will be skipped,
 * and why; switches the confirmed tabs one by one on the Session's own machine; then says what
 * happened to each.
 */
export function SessionSwitchToChatDialog({ where, sessionName, preview, onClose }: {
  where: SessionSwitchWhere;
  sessionName: string;
  preview: SessionChatSwitchPreview;
  onClose: () => void;
}) {
  const ready = switchable(preview.items);
  const skipped = preview.items.filter(item => item.skip);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionChatSwitchResult | null>(null);

  const switchNow = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await runSessionChatSwitch(where, preview.sessionId, ready.map(item => item.panelId)));
    } catch (failure) {
      setError(ipcErrorMessage(failure, 'Could not switch the Session to chat.'));
    } finally {
      setBusy(false);
    }
  };

  const tabs = (count: number) => `${count} tab${count === 1 ? '' : 's'}`;
  return (
    <Modal isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel="Switch Session to chat">
      <ModalHeader title={result ? 'Switched to chat' : `Switch ${sessionName} to chat`} />
      <ModalBody>
        {result ? (<>
          <p role="status" className="text-sm font-medium text-text-primary" data-testid="session-switch-summary">{summarizeSessionSwitch(result.items)}</p>
          {result.items.some(item => item.result === 'switched') && (
            <Section title="Switched">{result.items.filter(item => item.result === 'switched').map(item => <TabRow key={item.panelId} item={item} detail={item.note} />)}</Section>
          )}
          {result.items.some(item => item.result === 'failed') && (
            <Section title="Failed, terminal kept">{result.items.filter(item => item.result === 'failed').map(item => <TabRow key={item.panelId} item={item} detail={item.skip?.reason} />)}</Section>
          )}
          {result.items.some(item => item.result === 'skipped') && (
            <Section title="Skipped">{result.items.filter(item => item.result === 'skipped').map(item => <TabRow key={item.panelId} item={item} detail={item.skip && `${skipLabel(item.skip.kind)}: ${item.skip.reason}`} />)}</Section>
          )}
        </>) : (<>
          <p className="text-sm text-text-secondary">
            Each tab below continues its conversation in a chat tab, one at a time. If one can&apos;t, its terminal comes back running the same conversation and the others carry on.
          </p>
          <div className="mt-3">
            <Section title={`Will switch (${ready.length})`}>{ready.map(item => <TabRow key={item.panelId} item={item} />)}</Section>
            {skipped.length > 0 && (
              <Section title={`Will skip (${skipped.length})`}>{skipped.map(item => <TabRow key={item.panelId} item={item} detail={item.skip && `${skipLabel(item.skip.kind)}: ${item.skip.reason}`} />)}</Section>
            )}
          </div>
          {busy && <p role="status" className="mt-3 text-sm text-text-tertiary">Switching {tabs(ready.length)}…</p>}
          {error && <p role="alert" className="mt-3 text-sm text-status-error">{error}</p>}
        </>)}
      </ModalBody>
      <ModalFooter>
        {result ? <Button onClick={onClose}>Done</Button> : <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void switchNow()}>{busy ? 'Switching…' : error ? 'Try again' : `Switch ${tabs(ready.length)}`}</Button>
        </>}
      </ModalFooter>
    </Modal>
  );
}
