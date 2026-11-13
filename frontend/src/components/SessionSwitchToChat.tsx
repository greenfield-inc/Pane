import { useEffect, useState } from 'react';
import { Loader2, MessageSquare, ToggleRight } from 'lucide-react';
import type { SessionChatSwitchItem, SessionChatSwitchPreview, SessionChatSwitchResult } from '../../../shared/types/chatTab';
import { isChatTabsEnabled, useConfigStore } from '../stores/configStore';
import { cn } from '../utils/cn';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { PopoverButton } from './terminal/TerminalPopover';
import { byResult, previewSessionChatSwitch, runSessionChatSwitch, skipLabel, summarizeSessionSwitch, switchable, switchMenuState, turnOnChatTabsHere, type SessionSwitchMenuState, type SessionSwitchWhere } from '../utils/sessionChatSwitch';
import { Button } from './ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';

/**
 * What switching this Session to chat would do, read when its menu opens (`sessionId` set), so the
 * menu can always show Switch to chat: checking, ready, or why not. Here, chat tabs off is known
 * without asking; another machine says so in its preview.
 */
export function useSessionSwitchPreview(where: SessionSwitchWhere, sessionId: string | null, machineName = 'this machine'): SessionSwitchMenuState {
  const chatTabsHere = useConfigStore(state => isChatTabsEnabled(state.config));
  const machineId = where.kind === 'machine' ? where.machineId : null;
  const key = `${machineId ?? ''}:${sessionId ?? ''}:${chatTabsHere}`;
  const [read, setRead] = useState<{ key: string; menu: SessionSwitchMenuState } | null>(null);
  useEffect(() => {
    if (!sessionId || (machineId === null && !chatTabsHere)) return;
    let current = true;
    previewSessionChatSwitch(machineId === null ? { kind: 'here' } : { kind: 'machine', machineId }, sessionId)
      .then(preview => { if (current) setRead({ key, menu: switchMenuState(preview, machineName) }); })
      .catch(error => {
        // An older host has no preview: say it couldn't check, rather than hide the item.
        console.warn('[SwitchToChat] Could not read what the Session would switch:', error);
        if (current) setRead({ key, menu: { state: 'unavailable', reason: `Couldn't check this Session's tabs: ${ipcErrorMessage(error, 'no answer')}` } });
      });
    // Forgets this read when the menu closes, so reopening it checks again rather than showing an old answer.
    return () => { current = false; setRead(null); };
  }, [chatTabsHere, key, machineId, machineName, sessionId]);
  if (machineId === null && !chatTabsHere) return { state: 'unavailable', reason: `Chat tabs are off on ${machineName}`, turnOn: true };
  return read?.key === key ? read.menu : { state: 'checking' };
}

/**
 * Switch to chat in a Session's menu, always shown: a spinner while its machine checks, the
 * dialog when some tab can switch, or disabled with why not (and Turn on when chat tabs are off here).
 */
export function SessionSwitchMenuItem({ menu, onOpen, onClose }: { menu: SessionSwitchMenuState; onOpen: (preview: SessionChatSwitchPreview) => void; onClose: () => void }) {
  const unavailable = menu.state !== 'ready';
  const note = menu.state === 'checking' ? 'Checking…' : menu.state === 'unavailable' ? menu.reason : null;
  return (<>
    <PopoverButton
      role="menuitem"
      // Focusable while unavailable, so arrow keys reach it and its reason is announced.
      aria-disabled={unavailable}
      aria-busy={menu.state === 'checking'}
      data-testid="session-switch-to-chat"
      className={cn(unavailable && 'cursor-not-allowed')}
      onClick={() => { if (menu.state === 'ready') onOpen(menu.preview); }}
    >
      <span className={cn('flex items-center gap-2', unavailable && 'opacity-50')}>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {menu.state === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MessageSquare className="h-4 w-4" />}
        </span>
        Switch to chat…
      </span>
      {note && <span className="mt-0.5 block whitespace-normal pl-6 text-[11px] leading-tight text-text-tertiary">{note}</span>}
    </PopoverButton>
    {menu.state === 'unavailable' && menu.turnOn && (
      // Closes the menu: left open, it would shrink and slide Archive under the pointer. Reopened, it checks the Session.
      <PopoverButton role="menuitem" onClick={() => { onClose(); void turnOnChatTabsHere(); }}>
        <span className="flex items-center gap-2"><ToggleRight className="h-4 w-4" />Turn on chat tabs</span>
      </PopoverButton>
    )}
  </>);
}

const tabs = (count: number) => `${count} tab${count === 1 ? '' : 's'}`;

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

  const done = result && byResult(result.items);
  return (
    <Modal isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel="Switch Session to chat">
      <ModalHeader title={done ? (done.switched.length > 0 ? 'Switched to chat' : 'Nothing switched to chat') : `Switch ${sessionName} to chat`} />
      <ModalBody>
        {result && done ? (<>
          <p role="status" className="text-sm font-medium text-text-primary" data-testid="session-switch-summary">{summarizeSessionSwitch(result.items)}</p>
          {done.switched.length > 0 && (
            <Section title="Switched">{done.switched.map(item => <TabRow key={item.panelId} item={item} detail={item.note} />)}</Section>
          )}
          {done.failed.length > 0 && (
            <Section title="Failed, terminal kept">{done.failed.map(item => <TabRow key={item.panelId} item={item} detail={item.skip?.reason} />)}</Section>
          )}
          {done.skipped.length > 0 && (
            <Section title="Skipped">{done.skipped.map(item => <TabRow key={item.panelId} item={item} detail={item.skip && `${skipLabel(item.skip.kind)}: ${item.skip.reason}`} />)}</Section>
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
