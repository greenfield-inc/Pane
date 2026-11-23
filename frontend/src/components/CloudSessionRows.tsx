import { useState } from 'react';
import { AlertTriangle, Archive, MoreHorizontal, Pencil, Pin, PinOff, Play, Square, Trash2 } from 'lucide-react';
import { PausedGlyph } from './ui/AgentStatusDot';
import { SessionActivityCount, SessionActivityIcon } from './SessionActivity';
import { ConfirmDialog } from './ConfirmDialog';
import { RenameDialog } from './CompactSessionMenu';
import { SessionApprovalsCount } from './approvals/ApprovalsCount';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';
import { cn } from '../utils/cn';
import { commandOnMachine, openOnMachine, runOnMachine } from '../utils/machineRowActions';
import { showActionError } from '../stores/errorStore';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { useActiveMachineStore } from '../stores/activeMachineStore';
import { usePaneCloudStore } from '../stores/paneCloudStore';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import type { CloudSessionRow } from '../hooks/useCloudSessionRows';

/**
 * Sessions on another machine in the Sessions list: cloud Sessions, and this computer's while the
 * window is on a cloud Session. They look like any Session (status circle, spinner, "N working"); only
 * while an account is under review do cloud Sessions show an amber alert and a dimmed name.
 */
export function CloudSessionRows({ rows }: { rows: CloudSessionRow[] }) {
  const [menu, setMenu] = useState<{ row: CloudSessionRow; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<CloudSessionRow | null>(null);
  const [renaming, setRenaming] = useState<CloudSessionRow | null>(null);
  if (rows.length === 0 && !deleting && !renaming) return null;
  return (
    <>
      {rows.map((row) => (
        <CloudRow key={row.key} row={row} onMenu={(x, y) => setMenu({ row, x, y })} />
      ))}
      {menu && (
        <CloudSessionMenu
          {...menu}
          onClose={() => setMenu(null)}
          onDelete={() => { setDeleting(menu.row); setMenu(null); }}
          onRename={() => { setRenaming(menu.row); setMenu(null); }}
        />
      )}
      {renaming?.machineId && renaming.sessionId && (
        <RenameDialog
          noun="Session"
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          save={(name) => commandOnMachine(renaming.machineId ?? LOCAL_MACHINE_ID, { type: 'rename', target: { kind: 'session', id: renaming.sessionId ?? '' }, name })}
        />
      )}
      <ConfirmDialog
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting?.vmId) void deleteCloudSession(deleting.vmId, deleting.machineId); }}
        title={`Delete ${deleting?.cloudName ?? 'this cloud Session'}?`}
        message="This deletes the cloud Session with its machine and disk, and every Session on it. Work on it that you haven't pushed is lost."
        confirmText="Delete"
      />
    </>
  );
}

function CloudRow({ row, onMenu }: { row: CloudSessionRow; onMenu: (x: number, y: number) => void }) {
  const dimmed = row.underReview || row.stopped;
  return (
    <div className="group/orchestration-session relative" data-testid={`cloud-session-row-${row.key}`}>
      <div data-sidebar-row className="group/orchestration-row relative mx-2 flex h-7 w-[calc(100%-1rem)] items-center rounded-md text-[13px] text-text-secondary transition-colors hover:bg-surface-hover">
        <span className="ml-1 h-6 w-4 flex-shrink-0" aria-hidden="true" />
        <button
          type="button"
          data-sidebar-item
          aria-label={`Open Session ${row.name}`}
          onClick={() => void openCloudRow(row)}
          onContextMenu={(event) => { event.preventDefault(); if (hasMenu(row)) onMenu(event.clientX, event.clientY); }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded py-1 pl-2 pr-2 text-left focus:outline-none"
        >
          {row.underReview ? (
            <span className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center" title="Paused for review">
              <AlertTriangle className="h-3 w-3 text-status-warning" aria-label="Paused for review" />
            </span>
          ) : row.stopped && !row.busy ? (
            <PausedGlyph size="sm" className="flex-shrink-0" />
          ) : (
            <SessionActivityIcon state={row.busy ? 'working' : row.activity} />
          )}
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', dimmed ? 'text-text-muted' : 'font-medium text-text-primary')}>{row.name}</span>
          {!dimmed && (row.sessionId && row.machineId
            ? <SessionApprovalsCount sessionId={row.sessionId} machineId={row.machineId} otherwise={<SessionActivityCount blocked={0} working={row.workingPanes} panes={0} />} />
            : <SessionActivityCount blocked={0} working={row.workingPanes} panes={0} />)}
        </button>
        {hasMenu(row) && (
          <div className="absolute inset-y-0.5 right-2 z-10 flex items-center bg-surface-secondary pr-0.5 opacity-0 transition-opacity group-hover/orchestration-row:bg-[linear-gradient(var(--color-surface-hover),var(--color-surface-hover))] group-hover/orchestration-row:opacity-100 group-focus-within/orchestration-row:opacity-100">
            <button
              type="button"
              aria-label={`Actions for ${row.name}`}
              aria-haspopup="menu"
              title="Session actions"
              onClick={(event) => {
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                onMenu(bounds.left, bounds.bottom);
              }}
              className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A cloud Session's row has Stop, Start and Delete; this computer's rows, shown while on a cloud Session, keep their own menu. */
function hasMenu(row: CloudSessionRow): boolean {
  return row.vmId !== null || (row.machineId === LOCAL_MACHINE_ID && row.sessionId !== null);
}

/** This computer's Session, acted on through its machine connection while the window is on a cloud Session. */
function LocalSessionMenu({ row, x, y, onClose, onRename }: { row: CloudSessionRow; x: number; y: number; onClose: () => void; onRename: () => void }) {
  const sessionId = row.sessionId;
  if (!sessionId) return null;
  const target = { kind: 'session' as const, id: sessionId };
  return (
    <TerminalPopover visible x={x} y={y} onClose={onClose} className="w-48">
      <div role="menu" aria-label={`${row.name} actions`} className="py-1">
        <PopoverButton role="menuitem" onClick={() => { onClose(); void runOnMachine(LOCAL_MACHINE_ID, { type: 'pin', target, pinned: !row.isPinned }, 'Could not pin or unpin the Session'); }}>
          <span className="flex items-center gap-2">{row.isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}{row.isPinned ? 'Unpin' : 'Pin'}</span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={onRename}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename…</span>
        </PopoverButton>
        <PopoverButton role="menuitem" variant="danger" onClick={() => { onClose(); void runOnMachine(LOCAL_MACHINE_ID, { type: 'archive', target }, 'Could not archive the Session'); }}>
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" />Archive Session</span>
        </PopoverButton>
      </div>
    </TerminalPopover>
  );
}

/** Stop, Start and Delete for a cloud Session in the list. */
function CloudSessionMenu({ row, x, y, onClose, onDelete, onRename }: { row: CloudSessionRow; x: number; y: number; onClose: () => void; onDelete: () => void; onRename: () => void }) {
  const vmId = row.vmId;
  if (!vmId) return <LocalSessionMenu row={row} x={x} y={y} onClose={onClose} onRename={onRename} />;
  return (
    <TerminalPopover visible x={x} y={y} onClose={onClose} className="w-48">
      <div role="menu" aria-label={`${row.name} actions`} className="py-1">
        {row.stopped ? (
          <PopoverButton role="menuitem" disabled={row.underReview} onClick={() => { onClose(); void usePaneCloudStore.getState().start(vmId); }}>
            <span className="flex items-center gap-2"><Play className="h-4 w-4" />Start</span>
          </PopoverButton>
        ) : (
          <PopoverButton role="menuitem" onClick={() => { onClose(); void stopCloudSession(vmId, row.machineId); }}>
            <span className="flex items-center gap-2"><Square className="h-4 w-4" />Stop</span>
          </PopoverButton>
        )}
        <PopoverButton role="menuitem" onClick={() => { onClose(); void archiveCloudSession(vmId, row.machineId); }}>
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" />Archive Session</span>
        </PopoverButton>
        <PopoverButton role="menuitem" variant="danger" onClick={onDelete}>
          <span className="flex items-center gap-2"><Trash2 className="h-4 w-4" />Delete…</span>
        </PopoverButton>
      </div>
    </TerminalPopover>
  );
}

/** Leaves a cloud Session the window is on for this computer, so stopping it doesn't strand the window. */
async function leaveIfOn(machineId: string | null): Promise<void> {
  if (!machineId || useActiveMachineStore.getState().machine?.id !== machineId) return;
  await useAllMachinesStore.getState().switchMachine?.(LOCAL_MACHINE_ID);
}

export async function stopCloudSession(vmId: string, machineId: string | null): Promise<void> {
  try {
    await leaveIfOn(machineId);
    await usePaneCloudStore.getState().stop(vmId);
  } catch (error) {
    showActionError('Could not stop the cloud Session', error);
  }
}

/**
 * Archives a cloud Session (D-94): its Session is archived, its machine is unlinked from all of the
 * person's computers at once and stops. It shows under Archived, where Restore pairs it again.
 */
export async function archiveCloudSession(vmId: string, machineId: string | null): Promise<void> {
  try {
    await leaveIfOn(machineId);
    await usePaneCloudStore.getState().archive(vmId);
  } catch (error) {
    showActionError('Could not archive the cloud Session', error);
    return;
  }
  // The store answers with the snapshot, whose error says what went wrong, or which computers still list it.
  const error = usePaneCloudStore.getState().snapshot.error;
  if (error) showActionError('Archive Session', [error.message, error.next].filter(Boolean).join(' '));
}

async function deleteCloudSession(vmId: string, machineId: string | null): Promise<void> {
  try {
    await leaveIfOn(machineId);
    await usePaneCloudStore.getState().remove(vmId);
  } catch (error) {
    showActionError('Could not delete the cloud Session', error);
  }
}

/** Opens the row's Session on its machine; a stopped cloud Session starts first. */
async function openCloudRow(row: CloudSessionRow): Promise<void> {
  const cloud = usePaneCloudStore.getState();
  if (row.underReview) {
    showActionError(`${row.name} is paused`, 'Your Pane Cloud Sessions are paused while we review unusual usage. Check your email for the review notice.');
    return;
  }
  if (row.stopped && row.vmId) {
    await cloud.start(row.vmId);
    const error = usePaneCloudStore.getState().snapshot.error;
    if (error) showActionError(`Could not start ${row.name}`, [error.message, error.next].filter(Boolean).join(' '));
    return;
  }
  if (!row.machineId) {
    showActionError(`Could not open ${row.name}`, 'This computer is not paired with this cloud Session. Open it from the computer that created it.');
    return;
  }
  if (!row.sessionId) {
    showActionError(`${row.name} is still starting`, 'Open it again in a moment.');
    return;
  }
  await openOnMachine(row.machineId, { kind: 'session', id: row.sessionId, name: row.name });
}
