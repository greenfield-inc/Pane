import { useHotkey } from './useHotkey';
import { toggleApprovals } from '../components/approvals/approvalsNavigation';
import { openApprovalsGroupBy, stepApproval, toggleSessionApproval } from '../components/approvals/approvalKeys';
import { canSendFocusedApproval, sendFocusedApproval } from '../components/approvals/approvalSend';

/**
 * The approvals catalog commands (D-381). ⇧⌘A works only while Pane is in front: the system-wide
 * answer-all key is a separate setting (notifyService.ts) and is left alone.
 */
export function useApprovalHotkeys(): void {
  useHotkey({
    id: 'toggle-approvals',
    label: 'Open or Close Approvals',
    category: 'approvals',
    action: toggleApprovals,
  });

  useHotkey({
    id: 'open-session-approval',
    label: 'Open This Session\'s Approval',
    category: 'approvals',
    action: toggleSessionApproval,
  });

  useHotkey({
    id: 'next-approval',
    label: 'Next Approval',
    category: 'approvals',
    action: () => stepApproval(1),
  });

  useHotkey({
    id: 'previous-approval',
    label: 'Previous Approval',
    category: 'approvals',
    action: () => stepApproval(-1),
  });

  useHotkey({
    id: 'approvals-group-by',
    label: 'Approvals: Group By',
    category: 'approvals',
    action: openApprovalsGroupBy,
  });

  // Only inside an open approval, so ⌘↩ still sends from the chat composer and the terminal.
  // A context key, not a palette command: the palette would take the focus it acts on.
  useHotkey({
    id: 'send-approval',
    label: 'Send Approval Answer',
    category: 'approvals',
    enabled: canSendFocusedApproval,
    action: sendFocusedApproval,
    showInPalette: false,
  });
}
