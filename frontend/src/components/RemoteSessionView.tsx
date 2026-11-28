import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Monitor, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import ChatTabPanel from './chatTab/ChatTabPanel';
import { LoadingStatus } from './ui/Skeleton';
import { cn } from '../utils/cn';
import { chatTabViewer, firstPaintWindow } from '../../../shared/chatTabViewer';
import { switchMark } from '../../../shared/switchMarks';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { machineMirrorApi, useMachineMirrorStore } from '../stores/machineMirrorStore';
import { heldRemoteChat, remoteChatClient, showFullRemoteChat, remoteSessionKey, useRemoteSessionView, type RemoteSessionEntry, type RemoteSessionTarget } from '../stores/remoteSessionView';
import { clickEngages, dismissKept, engageKey, engageRemoteSession, holdRemoteText, keptEngage, useRemoteEngage, type EngageCause, type HeldText } from '../services/remoteEngage';
import type { MachineMirrorListing, MachineMirrorSync } from '../../../shared/types/machineMirror';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';

/** Controls of the read-only view a click on doesn't engage (Earlier messages, a link). */
const VIEW_CONTROLS = 'button, a, [role="tab"], [role="button"], summary';

function pick({ button, metaKey, ctrlKey, shiftKey, altKey }: React.MouseEvent) {
  return { button, metaKey, ctrlKey, shiftKey, altKey };
}

/** How long the cursor stays on a remote chat before all the messages held are drawn. */
const REMOTE_FULL_WINDOW_REST_MS = 150;

/** "14:02": when an offline machine was last heard from, in this computer's time. */
function clockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Another machine's Session under the sidebar cursor (T-116 PR 6), read-only: its name, the machine
 * it is on, its tabs (shown, not usable) and its chat, from the desktop mirror or one read of its
 * host. Nothing here acts on that machine. Typing into its message box, Enter, or a click into it
 * engages the Session (PR 7, T-132): the window switches to that machine, this view staying on
 * screen meanwhile, and what was typed goes into the chat there once it shows.
 *
 * Marks: an "Offline · last seen" chip and a note in place of the message box when the machine is
 * offline; "Updating from …" while the mirror catches up; and, for a chat the host hasn't read since
 * it restarted, a note that its messages load when it is opened there.
 */
export function RemoteSessionTileBody({ target, held = false }: { target: RemoteSessionTarget; held?: boolean }) {
  const { machineId, sessionId } = target;
  const entry = useRemoteSessionView(state => state.entries[remoteSessionKey(machineId, sessionId)]);
  const listing = useMachineMirrorStore(state => state.listings[machineId]);
  const machine = useAllMachinesStore(state => state.machines.find(candidate => candidate.id === machineId));
  const row = useAllMachinesStore(state => state.snapshots[machineId]?.sessions.find(session => session.id === sessionId));
  const chatPanelId = heldRemoteChat(entry)?.panelId;
  const blockedRun = useRemoteSessionView(state => (chatPanelId ? state.earlierUnavailable[remoteSessionKey(machineId, chatPanelId)] : undefined));
  const earlierBlocked = blockedRun !== undefined && blockedRun === heldRemoteChat(entry)?.generation;
  return <RemoteSessionPanel target={target} entry={entry} listing={listing} machine={machine} row={row} earlierBlocked={earlierBlocked} held={held} />;
}

/** What `RemoteSessionTileBody` shows, from what the stores hold. */
export function RemoteSessionPanel({ target, entry, listing, machine, row, earlierBlocked, held = false }: {
  target: RemoteSessionTarget;
  entry: RemoteSessionEntry | undefined;
  listing: MachineMirrorListing | undefined;
  machine: MachineState | undefined;
  /** The All machines row's record, for a Session nothing was read of yet. */
  row: OrchestrationSessionSummary | undefined;
  /** Its host said earlier messages can't be read until the chat runs there (D-19, QA F-2). */
  earlierBlocked: boolean;
  /** Held over the main area while an engage switches (T-132): the newest 30 messages, never more. */
  held?: boolean;
}) {
  const { machineId, sessionId } = target;
  const machineName = machine?.label ?? 'another machine';
  const online = machine?.status === 'online';
  const sync: MachineMirrorSync = !online ? 'offline' : listing?.state.sync ?? 'live';
  const lastSeen = clockTime(listing?.state.lastSeenAt ?? machine?.offlineSince);
  const record = entry?.read?.view?.session ?? entry?.snapshot?.session ?? row;
  const name = record?.name ?? 'Session';
  const chat = heldRemoteChat(entry);
  const tabs = entry?.read?.panels ?? entry?.snapshot?.tabs ?? [];
  const agentPanelId = entry?.read?.view?.panel.id ?? chat?.panelId;
  const terminal = entry?.read?.view ? entry.read.view.panel.type !== 'chat' : false;
  // Not known yet, which is not empty: the host restarted and has no saved window for this chat.
  const unknown = !chat?.transcript && entry?.snapshot?.transcriptUnknown === true;
  const client = useMemo(() => remoteChatClient(machineId, machineName, { held }), [machineId, machineName, held]);
  const readAt = entry?.readAt ?? 0;
  const keptText = useRemoteEngage(state => state.held[remoteSessionKey(machineId, sessionId)] !== undefined);

  // The chat paints the newest 30 messages held at once (drawing 200 takes a long chat ~95 ms);
  // the rest of what is held follows once the cursor stays. A newer copy (the mirror caught up, the
  // host's read landed) reaches the chat through its client's onReconnect.
  useMemo(() => {
    if (!chat) return;
    const viewer = chatTabViewer(client, chat.panelId);
    viewer.setStartOnRead(false);
    // Left, it keeps nothing and pushes none of this computer's kept chats out; the next visit paints the mirror's window.
    viewer.setKeepOnClose(false);
    viewer.prime(firstPaintWindow(chat), performance.now());
  }, [client, chat]);
  const panelId = chat?.panelId;
  useEffect(() => {
    if (!panelId || held) return undefined;
    const viewer = chatTabViewer(client, panelId);
    const rest = setTimeout(() => {
      showFullRemoteChat(machineId, panelId, true);
      void viewer.refresh();
    }, REMOTE_FULL_WINDOW_REST_MS);
    return () => {
      clearTimeout(rest);
      showFullRemoteChat(machineId, panelId, false);
    };
  }, [client, machineId, panelId]);

  // While shown and the machine answers, the chat follows the host's events for it, and only for it.
  const followed = online && chat ? chat.panelId : undefined;
  useEffect(() => {
    const api = machineMirrorApi();
    if (!followed || !api) return undefined;
    api.followChat({ machineId, panelId: followed });
    return () => api.followChat(null);
  }, [machineId, followed]);

  const shown = chat?.transcript?.messages.length ?? -1;
  useLayoutEffect(() => {
    switchMark('remote:paint', { machineId, sessionId, n: shown, status: readAt > 0 ? 'filled' : 'mirror' });
  }, [machineId, sessionId, shown, readAt]);

  let body: React.ReactNode;
  if (terminal) {
    body = <RemoteNote>This Session&apos;s agent runs in a terminal. Press Enter to open it on {machineName}.</RemoteNote>;
  } else if (chat && !unknown) {
    body = <ChatTabPanel
      key={`${machineId}:${chat.panelId}`}
      panelId={chat.panelId}
      client={client}
      connected={online}
      machine={{ id: machineId, name: machineName, os: null, slot: 0, letters: '', local: false }}
      // Read-only here: no /clear, and no Clear button.
      clearable={false}
      earlierNote={earlierBlocked ? `Older messages load once this chat is opened on ${machineName}.` : undefined}
      // Offline, what was typed and not sent stays in its box with why (QA 1781 F-1); otherwise a note.
      watchOnly={online || keptText ? { composer: <RemoteHeldComposer target={target} machineName={machineName} takesFocus={held} /> } : { note: `${machineName} is offline. This is what it last sent.` }}
    />;
  } else if (unknown) {
    body = <RemoteNote>Messages load when this Session is opened on {machineName}.</RemoteNote>;
  } else if (entry?.read && !entry.read.view) {
    // The host has nothing to show yet (the Session's tab doesn't exist until it is opened there).
    body = <RemoteNote>This Session opens on {machineName} when you press Enter.</RemoteNote>;
  } else if (entry?.error && !online) {
    body = <RemoteNote>{machineName} is offline, and Pane has no copy of this Session yet.</RemoteNote>;
  } else if (entry?.error) {
    body = <RemoteNote role="alert">{entry.error}</RemoteNote>;
  } else if (!online) {
    body = <RemoteNote>{machineName} is offline, and Pane has no copy of this Session yet.</RemoteNote>;
  } else {
    body = <div className="flex min-h-0 flex-1 items-center justify-center p-4"><LoadingStatus label={`Reading ${name} from ${machineName}`} /><p className="text-sm text-text-tertiary">Reading from {machineName}…</p></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="remote-session-view" data-machine-id={machineId} data-session-id={sessionId} data-sync={sync}
      data-messages={shown} data-filled={readAt > 0 || undefined}>
      <div className="flex min-h-11 flex-shrink-0 items-center gap-2 border-b border-border-primary px-4 py-1.5">
        <h1 className="min-w-0 truncate text-sm font-semibold text-text-primary">{name}</h1>
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-surface-secondary px-1.5 py-0.5 text-[11px] text-text-secondary" data-testid="remote-session-machine">
          <Monitor className="h-3 w-3" aria-hidden />On {machineName}
        </span>
        {sync === 'offline' && (
          <span className="flex-shrink-0 rounded border border-border-primary px-1.5 py-0.5 text-[11px] text-text-tertiary" data-testid="remote-session-offline">
            Offline{lastSeen ? ` · last seen ${lastSeen}` : ''}
          </span>
        )}
        {sync === 'catching-up' && <span role="status" className="flex-shrink-0 text-[11px] text-text-tertiary" data-testid="remote-session-catching-up">Updating from {machineName}</span>}
      </div>
      {tabs.length > 0 && (
        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-border-primary px-2 py-1" role="tablist" aria-label={`${name}'s tabs on ${machineName}`} aria-disabled>
          {tabs.map(tab => (
            <span key={tab.id} role="tab" aria-selected={tab.id === agentPanelId} aria-disabled
              title={`Opens on ${machineName}`}
              className={cn('max-w-48 flex-shrink-0 cursor-default truncate rounded px-2 py-0.5 text-xs', tab.id === agentPanelId ? 'bg-surface-selected text-text-primary' : 'text-text-tertiary')}>
              {tab.title}
            </span>
          ))}
        </div>
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', sync === 'offline' && 'opacity-90')}
        // A plain click into the chat or its message box engages it there (T-132); selecting text
        // to copy, a right-click or a control (Earlier messages) does not.
        onMouseUp={event => {
          const press = { ...pick(event), inControl: event.target instanceof Element && event.target.closest(VIEW_CONTROLS) !== null };
          if (online && clickEngages(press, window.getSelection()?.toString() ?? '')) engageRemoteSession(target, 'click');
        }}>{body}</div>
    </div>
  );
}

/**
 * The message box of another machine's Session (T-132). It takes text at once: the first key
 * engages the Session, and the text is held here, still editable, until the chat there takes it.
 * Enter sends it there once the switch lands. A failed switch keeps the text with the reason.
 */
function RemoteHeldComposer({ target, machineName, takesFocus }: { target: RemoteSessionTarget; machineName: string; takesFocus: boolean }) {
  const key = engageKey(target);
  const held = useRemoteEngage(state => state.held[key]);
  const failure = useRemoteEngage(state => (state.failure && engageKey(state.failure) === key ? state.failure.message : undefined));
  const engagingCause = useRemoteEngage(state => (state.engaging && engageKey(state.engaging) === key ? state.engaging.cause : undefined));
  const waiting = useRemoteEngage(state => state.engaging?.waiting === true && engageKey(state.engaging) === key);
  return <HeldComposerBox target={target} machineName={machineName} held={held} failure={failure} engagingCause={engagingCause} takesFocus={takesFocus} waiting={waiting} />;
}

/** What `RemoteHeldComposer` draws, from what the engage store holds for the Session. */
export function HeldComposerBox({ target, machineName, held, failure, engagingCause, takesFocus = false, waiting = false }: {
  target: RemoteSessionTarget;
  machineName: string;
  held: HeldText | undefined;
  failure: string | undefined;
  engagingCause: EngageCause | undefined;
  /** The box held over the main area: the one that takes focus while the switch runs (the tile's goes with the switch). */
  takesFocus?: boolean;
  /** The window switched but the link there is down: nothing is sent until it is back (QA 1781 F-1). */
  waiting?: boolean;
}) {
  const key = engageKey(target);
  const box = useRef<HTMLTextAreaElement>(null);
  // Typed on the sidebar row, or into the tile's box before the hold over the main area drew it:
  // the held box takes focus, the caret at the end.
  useLayoutEffect(() => {
    const input = box.current;
    if (!takesFocus || engagingCause !== 'type' || !input || document.activeElement === input) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && !active.hasAttribute('data-remote-composer')) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [engagingCause, takesFocus]);
  const text = held?.text ?? '';
  return (
    <div className="chat-composer" data-pane-part="chat-composer">
      {failure && <p role="alert" className="chat-notice" data-testid="remote-engage-error">{failure}</p>}
      <div className="chat-input-box">
        <textarea
          ref={box}
          data-remote-composer={key}
          className="chat-input"
          rows={1}
          value={text}
          readOnly={held?.send === true}
          aria-label={`Message on ${machineName}`}
          placeholder={`Type to continue on ${machineName}`}
          onChange={event => {
            holdRemoteText(target, event.target.value);
            if (event.target.value) engageRemoteSession(target, 'type');
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              engageRemoteSession(target, 'enter', { send: true });
            }
          }}
        />
      </div>
      {held?.notSent && <p role="alert" className="chat-notice" data-testid="remote-engage-not-sent">{held.notSent}</p>}
      {!held?.notSent && waiting && held && <p role="status" className="chat-notice" data-testid="remote-engage-pending">Not sent yet: waiting for {machineName} to answer. {held.send ? 'It sends there once it does.' : 'It goes into the chat there once it does.'}</p>}
      {!waiting && !held?.notSent && held?.send && engagingCause && <p role="status" className="chat-notice" data-testid="remote-engage-sending">Sends on {machineName} once it opens there.</p>}
    </div>
  );
}

function RemoteNote({ children, role = 'status' }: { children: React.ReactNode; role?: 'status' | 'alert' }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center"><p role={role} className="max-w-md text-sm text-text-secondary">{children}</p></div>;
}

/**
 * While a switch to another machine's Session runs (an engage, T-132), its mirror view stays on
 * screen over the main area, still taking text, so nothing flashes back to this computer or blank;
 * the live view underneath takes over once its chat paints there.
 */
export function EngageHold() {
  const engaging = useRemoteEngage(state => state.engaging);
  const target = useMemo(() => (engaging ? { machineId: engaging.machineId, sessionId: engaging.sessionId } : undefined), [engaging?.machineId, engaging?.sessionId]);
  if (!target) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg-primary" data-testid="engage-hold" data-machine-id={target.machineId} data-session-id={target.sessionId}>
      <RemoteSessionTileBody target={target} held />
    </div>
  );
}

/**
 * Text typed into another machine's Session that wasn't delivered (QA 1781 F-1): the switch failed
 * (the checklist may cover the main area), or the chat there hasn't opened yet. It floats beside
 * whatever the main area shows, outside its dimming, with why; Enter tries again, and the chat
 * there takes it once as it opens.
 */
export function EngageKept() {
  const kept = useRemoteEngage(useShallow(keptEngage));
  const name = useAllMachinesStore(state => (kept ? state.machines.find(machine => machine.id === kept.machineId)?.label : undefined));
  // Drawn again when a waiting Enter's deadline passes, so the bar stops saying it sends.
  const [now, setNow] = useState(() => Date.now());
  const sendsBy = kept?.sendsBy;
  useEffect(() => {
    if (sendsBy === undefined) return undefined;
    setNow(Date.now());
    const wait = sendsBy - Date.now();
    if (wait < 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), wait + 1);
    return () => clearTimeout(timer);
  }, [sendsBy]);
  const takesFocus = useRemoteEngage(state => state.keptFocus === true);
  if (!kept) return null;
  return <KeptBar kept={kept} machineName={name ?? 'the other machine'} now={now} takesFocus={takesFocus} />;
}

/** What `EngageKept` draws. */
export function KeptBar({ kept, machineName, now = Date.now(), takesFocus = false }: { kept: NonNullable<ReturnType<typeof keptEngage>>; machineName: string; now?: number; takesFocus?: boolean }) {
  const target = { machineId: kept.machineId, sessionId: kept.sessionId };
  const box = useRef<HTMLTextAreaElement>(null);
  // The switch failed while the person typed: the next key goes here, not to the page (M-280).
  useLayoutEffect(() => {
    const input = box.current;
    if (!takesFocus || !input) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !active.closest('[data-testid="engage-hold"], [data-remote-composer]')) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [takesFocus]);
  let sends = '';
  if (kept.sendsBy !== undefined) sends = now <= kept.sendsBy ? ' It sends then.' : ' It goes in unsent: its 60 s to send have passed.';
  return (
    <div role="region" aria-label={`Not sent to ${machineName}`} data-testid="engage-kept" data-pending={kept.pending || undefined}
      className="fixed bottom-4 right-4 z-fixed w-[420px] max-w-[calc(100vw-2rem)] rounded-lg border border-border-primary bg-surface-primary p-3 text-text-primary shadow-dropdown">
      <div className="mb-2 flex items-start gap-2">
        <p role={kept.pending && !kept.notSent ? 'status' : 'alert'} className="min-w-0 flex-1 text-xs text-text-secondary">{kept.notSent ?? (kept.pending ? `${kept.message}${sends}` : `Not sent yet to ${machineName}: ${kept.message}`)}</p>
        <button type="button" className="flex-shrink-0 rounded p-0.5 text-text-tertiary hover:text-text-primary" aria-label="Discard what you typed" title="Discard what you typed"
          onClick={() => { holdRemoteText(target, ''); dismissKept(); }}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <textarea
        ref={box}
        className="chat-input w-full"
        rows={2}
        value={kept.text}
        aria-label={`Message on ${machineName}, not sent yet`}
        onChange={event => holdRemoteText(target, event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            engageRemoteSession(target, 'enter', { send: true });
          }
        }}
      />
      <p className="mt-1 text-[11px] text-text-tertiary">Press Enter to send it on {machineName}.</p>
    </div>
  );
}
