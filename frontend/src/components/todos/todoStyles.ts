/**
 * The To-dos screens' shared shapes, from the approved design (round 6): its buttons, pills and
 * chips, in theme tokens.
 */

/** A bordered button, 28 px high (New to-do, Group, Stop, Open). */
export const TODOS_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-2.5 text-[12.5px] text-text-primary hover:border-border-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:cursor-not-allowed disabled:opacity-50';

/** The list header's buttons (Group, New to-do): 30 px at 13 px (T-6). */
export const TODOS_HEADER_BUTTON = 'inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-2.5 text-[13px] text-text-primary hover:border-border-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:cursor-not-allowed disabled:opacity-50';

/** A header tab (Open, Waiting on you, Done, All): 28 px at 13 px (T-6). */
export const TODOS_PILL = 'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive';
export const TODOS_PILL_ON = 'border-transparent bg-surface-tertiary font-medium text-text-primary';
export const TODOS_PILL_OFF = 'border-border-primary bg-surface-primary text-text-secondary hover:text-text-primary';

/** A row's chip: PR, Session, repo, sub-to-do count. 24 px at 12 px (T-6). */
export const TODOS_CHIP = 'inline-flex h-6 shrink-0 items-center gap-[5px] rounded-full border border-border-primary px-[9px] text-[12px] text-text-secondary';

/**
 * The list's leading columns: the row's left padding, then T-n in a fixed width, then the status
 * icon. Rows and the queued group's load line share them, so the load line's icon sits under the
 * status icons and its text under the titles.
 */
export const TODOS_ROW_LEAD = 'gap-2.5 pl-3.5';
export const TODOS_REF_COLUMN = 'w-11 shrink-0';

/** A chip in the New to-do dialog (status, repo, machine, agent, + Done when). */
export const TODOS_DIALOG_CHIP = 'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-[9px] text-[12px] text-text-secondary hover:border-border-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive';
