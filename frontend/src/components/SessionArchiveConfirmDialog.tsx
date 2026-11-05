import { useRef } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { useSessionArchiveConfirmStore } from './orchestrationSessionActions';
import type { RunpanePaneArchiveBlockCode } from '../../../shared/types/runpaneOrchestration';

const BLOCK_REASONS = {
  'agent-busy': 'An agent is working or waiting for an answer',
  'unsent-input': 'A tab has text typed but not sent, or unsaved edits',
  'uncommitted-changes': 'Uncommitted changes',
  'unpushed-commits': 'Commits not pushed',
  'uncommitted-and-unpushed': 'Uncommitted changes and commits not pushed',
  'status-unknown': 'Pane could not check for unsaved work',
} satisfies Record<RunpanePaneArchiveBlockCode, string>;

/** Asks what to do with a Session's Panes that have work in progress before archiving the Session. */
export function SessionArchiveConfirmDialog() {
  const confirm = useSessionArchiveConfirmStore(state => state.confirm);
  const keepRef = useRef<HTMLButtonElement>(null);
  if (!confirm) return null;

  const unsafe = confirm.panes.flatMap(pane => pane.blocked ? [{ ...pane, blocked: pane.blocked }] : []);
  const total = confirm.panes.length;
  const title = `Archive ${confirm.sessionName}?`;

  return (
    <Modal isOpen onClose={() => confirm.choose(null)} size="md" ariaLabel={title} initialFocusRef={keepRef}>
      <div className="p-6 pt-2">
        <h3 className="mb-3 text-lg font-medium text-text-primary">{title}</h3>
        <p className="mb-3 text-text-secondary">
          Archiving this Session also archives its {total === 1 ? 'Pane' : `${total} Panes`}.{' '}
          {unsafe.length === 1 ? 'This one has' : `These ${unsafe.length} have`} work in progress:
        </p>
        <ul className="mb-3 max-h-60 space-y-1.5 overflow-y-auto">
          {unsafe.map(pane => (
            <li key={pane.paneId} className="min-w-0">
              <span className="font-medium text-text-primary">{pane.name}</span>
              <span className="text-text-secondary"> · {BLOCK_REASONS[pane.blocked]}</span>
            </li>
          ))}
        </ul>
        <p className="mb-6 text-sm text-text-tertiary">
          Archiving {unsafe.length === 1 ? 'it' : 'them'} stops agents, drops unsent text and removes the worktree, uncommitted changes included. Undo brings the Panes back, not those changes.
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={() => confirm.choose(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => confirm.choose('keep')} ref={keepRef}>
            Keep {unsafe.length === 1 ? 'it' : 'them'} open
          </Button>
          <Button variant="danger" onClick={() => confirm.choose('archive')}>Archive all</Button>
        </div>
      </div>
    </Modal>
  );
}
