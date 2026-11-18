/**
 * The names the approvals keys find their surfaces by. Components render these and key handlers
 * query them from here, so renaming one moves both: ⌘↩ send, ⌥⌘A, paging and Esc can't silently
 * lose the element they look for.
 */

export const APPROVAL_COLUMN_ID = 'approval-column';
export const APPROVAL_REPLY_BOX_ID = 'approval-reply-box';
export const APPROVALS_ROW_ID = 'approvals-row';
export const APPROVALS_BESIDE_ID = 'approvals-beside';
export const APPROVALS_SORT_ID = 'approvals-sort';

const byTestId = (id: string) => `[data-testid="${id}"]`;

/** An approval's column, wherever it is shown (a Session, Autopilot, the Approvals screen). */
export const APPROVAL_COLUMN = byTestId(APPROVAL_COLUMN_ID);
export const APPROVAL_REPLY_BOX = byTestId(APPROVAL_REPLY_BOX_ID);
/** A row of the Approvals screen's list. */
export const APPROVALS_ROW = byTestId(APPROVALS_ROW_ID);
/** The Approvals screen's column, beside its list. */
export const APPROVALS_BESIDE_COLUMN = `${byTestId(APPROVALS_BESIDE_ID)} ${APPROVAL_COLUMN}`;
/** The Approvals screen's Group by menu button. */
export const APPROVALS_SORT = byTestId(APPROVALS_SORT_ID);
/** A Session's approval column region (data-focus-region, set by SessionWorkspacePanels). */
export const APPROVALS_REGION = '[data-focus-region="approvals"]';

/** The column's pager buttons: render with `approvalStepProps`, find with `approvalStepButton`. */
export type ApprovalStep = 'next' | 'previous';
export const approvalStepProps = (step: ApprovalStep) => ({ 'data-approval-step': step });
export const approvalStepButton = (step: ApprovalStep) => `[data-approval-step="${step}"]`;

/** A menu, list box or dialog is open: it takes Esc and the list keys first. */
export const OPEN_MENU_OR_DIALOG = '[role="menu"], [role="listbox"], [aria-modal="true"]';
