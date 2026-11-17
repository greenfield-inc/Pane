/**
 * The To-dos screens' shared shapes, from the approved design (round 6): its buttons, pills and
 * chips, in theme tokens.
 */

/** A bordered button, 28 px high (New to-do, Group, Stop, Open). */
export const TODOS_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-2.5 text-[12.5px] text-text-primary hover:border-border-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:cursor-not-allowed disabled:opacity-50';

/** A header tab (Open, Waiting on you, Done, All). */
export const TODOS_PILL = 'inline-flex h-[26px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[12.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive';
export const TODOS_PILL_ON = 'border-transparent bg-surface-tertiary font-medium text-text-primary';
export const TODOS_PILL_OFF = 'border-border-primary bg-surface-primary text-text-secondary hover:text-text-primary';

/** A row's chip: PR, Session, repo, sub-to-do count. */
export const TODOS_CHIP = 'inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full border border-border-primary px-2 text-[11.5px] text-text-secondary';

/** A chip in the New to-do dialog (status, repo, machine, agent, + Done when). */
export const TODOS_DIALOG_CHIP = 'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-[9px] text-[12px] text-text-secondary hover:border-border-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive';
