import { normalizeKeyboardShortcutOverrides, resolveEffectiveChord } from '../../../../shared/utils/keyboardBindings';
import type { KeyboardShortcutId } from '../../../../shared/constants/keyboardShortcuts';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../../stores/configStore';
import { chordForEvent, rendererKeyPlatform } from '../../stores/hotkeyStore';
import { openSessionApproval, useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { showKeyHint } from '../../stores/keyHintStore';
import { leaveApprovalColumn } from '../../services/regionFocus';
import { firstToOpen, sessionApprovals } from './approvalCard';
import { openApprovals } from './approvalsNavigation';

/**
 * The approvals keys (standard keys only, D-381): the catalog commands' actions, and the helpers
 * the column and the Approvals screen share. Single keys (↑↓ Space Tab ↩ Esc) live in the
 * components; every key with a modifier is a catalog command the person can change.
 */

const COLUMN = '[data-testid="approval-column"]';

function isShown(element: Element): boolean {
  return element.isConnected && element.getClientRects().length > 0;
}

/** The key a catalog command answers to now ('' when it has none). */
function effectiveChord(id: KeyboardShortcutId): string {
  const config = useConfigStore.getState().config;
  const overrides = normalizeKeyboardShortcutOverrides(config?.keyboardShortcutOverrides).overrides;
  return resolveEffectiveChord(id, overrides, rendererKeyPlatform()) ?? '';
}

/** Whether a key press is one of these commands' keys, as the hotkey store would read it. */
export function pressedCommand<T extends KeyboardShortcutId>(event: KeyboardEvent, ids: readonly T[]): T | null {
  if (!areKeyboardShortcutsEnabled(useConfigStore.getState().config)) return null;
  const chord = chordForEvent(event);
  if (!chord) return null;
  return ids.find((id) => effectiveChord(id) === chord) ?? null;
}

/** A text field, where single keys type. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW'].includes(target.tagName) || target.closest('.xterm') !== null;
}

// --- Focus ---

/** Into an approval: its first question's focused option, else the column itself. */
export function focusFirstQuestion(column: HTMLElement): void {
  const option = Array.from(column.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"][tabindex="0"]')).find(isShown);
  const target = option ?? column.querySelector<HTMLElement>('[data-testid="approval-reply-box"]') ?? column;
  if (target === column && !column.hasAttribute('tabindex')) column.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: false });
}

/** Waits a few frames for something that is about to render, then acts on it. */
export function whenShown(find: () => HTMLElement | null, act: (element: HTMLElement) => void, frames = 20): void {
  const element = find();
  if (element && isShown(element)) { act(element); return; }
  if (frames <= 0) return;
  requestAnimationFrame(() => whenShown(find, act, frames - 1));
}

// --- This Session's approval (⌥⌘A) ---

/** The Session whose chat has focus, or the one shown; none on the Approvals screen. */
function currentSessionId(): string | null {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'pane-chat') return null;
  const host = document.activeElement?.closest('[data-session-content-id]')?.getAttribute('data-session-content-id');
  return host ?? useOrchestrationSessionStore.getState().selectedSessionId ?? null;
}

function sessionColumn(sessionId: string): HTMLElement | null {
  const content = document.querySelector(`[data-session-content-id="${CSS.escape(sessionId)}"]`);
  const column = content?.querySelector<HTMLElement>(`[data-focus-region="approvals"] ${COLUMN}`);
  return column && isShown(column) ? column : null;
}

/**
 * From a Session's chat: opens its approval on the right with focus on the first question. Pressed
 * again from the approval, back to the chat (the draft stays). With nothing waiting, a quiet hint.
 */
export function toggleSessionApproval(): void {
  const sessionId = currentSessionId();
  if (!sessionId) {
    showKeyHint('Open a Session’s chat to answer its approvals there.');
    return;
  }
  const open = sessionColumn(sessionId);
  if (open?.contains(document.activeElement)) {
    leaveApprovalColumn();
    return;
  }
  if (!useApprovalColumnStore.getState().open[`session:${sessionId}`]) {
    const first = firstToOpen(sessionApprovals(selectNotifyItems(useNotifyStore.getState()), sessionId));
    if (!first) {
      showKeyHint('Nothing in this Session is waiting on you.');
      return;
    }
    openSessionApproval(sessionId, first.id);
  }
  whenShown(() => sessionColumn(sessionId), focusFirstQuestion);
}

// --- Next / previous approval, from anywhere ---

/**
 * Pages the approval column with focus, else the one shown; with none shown, opens this Session's
 * approval from its chat, or Approvals.
 */
export function stepApproval(direction: 1 | -1): void {
  const columns = Array.from(document.querySelectorAll<HTMLElement>(COLUMN)).filter(isShown);
  const column = columns.find((candidate) => candidate.contains(document.activeElement)) ?? columns[0];
  if (column) {
    column.querySelector<HTMLButtonElement>(`[data-approval-step="${direction > 0 ? 'next' : 'previous'}"]`)?.click();
    return;
  }
  const sessionId = currentSessionId();
  if (sessionId && firstToOpen(sessionApprovals(selectNotifyItems(useNotifyStore.getState()), sessionId))) {
    toggleSessionApproval();
    return;
  }
  openApprovals();
}

// --- Group by ---

/** Opens Approvals' Group by menu, opening Approvals first when it is elsewhere. */
export function openApprovalsGroupBy(): void {
  if (useNavigationStore.getState().activeView !== 'notify') openApprovals();
  whenShown(() => document.querySelector<HTMLElement>('[data-testid="approvals-sort"]'), (trigger) => {
    trigger.focus();
    trigger.click();
  });
}
