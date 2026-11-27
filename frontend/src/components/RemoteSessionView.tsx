import { useEffect, useLayoutEffect, useMemo } from 'react';
import { Monitor } from 'lucide-react';
import ChatTabPanel from './chatTab/ChatTabPanel';
import { LoadingStatus } from './ui/Skeleton';
import { cn } from '../utils/cn';
import { chatTabViewer } from '../../../shared/chatTabViewer';
import { switchMark } from '../../../shared/switchMarks';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { useMachineMirrorStore } from '../stores/machineMirrorStore';
import { heldRemoteChat, remoteChatClient, remoteSessionKey, useRemoteSessionView, type RemoteSessionEntry, type RemoteSessionTarget } from '../stores/remoteSessionView';
import type { MachineMirrorListing, MachineMirrorSync } from '../../../shared/types/machineMirror';
import { SESSION_SNAPSHOT_MESSAGE_LIMIT } from '../../../shared/types/sessionSnapshot';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';

/** How long the cursor stays on a remote chat before all the messages held are drawn. */
const REMOTE_FULL_WINDOW_REST_MS = 150;

/** The newest messages a first paint draws: the window the mirror holds (D-3). */
function firstPaint(chat: ChatTabView): ChatTabView {
  const transcript = chat.transcript;
  const extra = transcript ? transcript.messages.length - SESSION_SNAPSHOT_MESSAGE_LIMIT : 0;
  if (!transcript || extra <= 0) return chat;
  return { ...chat, transcript: { ...transcript, start: transcript.start + extra, messages: transcript.messages.slice(extra) } };
}

/** "14:02": when an offline machine was last heard from, in this computer's time. */
function clockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Another machine's Session under the sidebar cursor (T-116 PR 6), read-only: its name, the machine
 * it is on, its tabs (shown, not usable) and its chat, from the desktop mirror or one read of its
 * host. Nothing here acts on that machine; Enter or a click on its row opens it there.
 *
 * Marks: an "Offline · last seen" chip and a note in place of the message box when the machine is
 * offline; "Updating from …" while the mirror catches up; and, for a chat the host hasn't read since
 * it restarted, a note that its messages load when it is opened there.
 */
export function RemoteSessionTileBody({ target }: { target: RemoteSessionTarget }) {
  const { machineId, sessionId } = target;
  const entry = useRemoteSessionView(state => state.entries[remoteSessionKey(machineId, sessionId)]);
  const listing = useMachineMirrorStore(state => state.listings[machineId]);
  const machine = useAllMachinesStore(state => state.machines.find(candidate => candidate.id === machineId));
  const row = useAllMachinesStore(state => state.snapshots[machineId]?.sessions.find(session => session.id === sessionId));
  return <RemoteSessionPanel target={target} entry={entry} listing={listing} machine={machine} row={row} />;
}

/** What `RemoteSessionTileBody` shows, from what the stores hold. */
export function RemoteSessionPanel({ target, entry, listing, machine, row }: {
  target: RemoteSessionTarget;
  entry: RemoteSessionEntry | undefined;
  listing: MachineMirrorListing | undefined;
  machine: MachineState | undefined;
  /** The All machines row's record, for a Session nothing was read of yet. */
  row: OrchestrationSessionSummary | undefined;
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
  const client = useMemo(() => remoteChatClient(machineId, machineName), [machineId, machineName]);
  const readAt = entry?.readAt ?? 0;

  // The chat paints the newest 30 messages held at once (drawing 200 takes a long chat ~95 ms);
  // the rest of what is held follows once the cursor stays, and again when the host's read lands.
  useMemo(() => {
    if (!chat) return;
    const viewer = chatTabViewer(client, chat.panelId);
    viewer.setStartOnRead(false);
    viewer.prime(firstPaint(chat), performance.now());
  }, [client, chat]);
  const panelId = chat?.panelId;
  useEffect(() => {
    if (!panelId) return undefined;
    const viewer = chatTabViewer(client, panelId);
    const rest = setTimeout(() => { void viewer.refresh(); }, REMOTE_FULL_WINDOW_REST_MS);
    return () => {
      clearTimeout(rest);
      // Left: the next visit paints the short window again. After the chat's own unsubscribe.
      queueMicrotask(() => viewer.forgetMessages());
    };
  }, [client, panelId]);
  useEffect(() => {
    if (panelId && readAt > 0) void chatTabViewer(client, panelId).refresh();
  }, [client, panelId, readAt]);

  // While shown and the machine answers, the chat follows the host's events for it, and only for it.
  const followed = online && chat ? chat.panelId : undefined;
  useEffect(() => {
    const api = window.electronAPI?.machineMirror;
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
      watchOnly={online ? { placeholder: `Type to continue on ${machineName}` } : { note: `${machineName} is offline. This is what it last sent.` }}
    />;
  } else if (unknown) {
    body = <RemoteNote>Messages load when this Session is opened on {machineName}.</RemoteNote>;
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
      <div className={cn('flex min-h-0 flex-1 flex-col', sync === 'offline' && 'opacity-90')}>{body}</div>
    </div>
  );
}

function RemoteNote({ children, role = 'status' }: { children: React.ReactNode; role?: 'status' | 'alert' }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center"><p role={role} className="max-w-md text-sm text-text-secondary">{children}</p></div>;
}
