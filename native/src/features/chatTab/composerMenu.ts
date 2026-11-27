/*
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code, commit 2808e878d), apps/web/src/components/chat/useComposerTriggerState.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { detectComposerTrigger, isSameTrigger, type ComposerTrigger } from '@shared/composerMentions';

/** `open` is the menu's trigger; `dismissed` is the word a paste left closed. */
export interface ComposerMenuState {
  open: ComposerTrigger | null;
  dismissed: ComposerTrigger | null;
}

export const CLOSED_MENU: ComposerMenuState = { open: null, dismissed: null };

/** Where `previous` became `next`: the caret after the edit, and how many characters it added. */
function editOf(previous: string, next: string): { caret: number; added: number } {
  const limit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < limit && previous[start] === next[start]) start += 1;
  let tail = 0;
  while (tail < limit - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return { caret: next.length - tail, added: next.length - tail - start };
}

/**
 * The menu after a text edit. The phone is not told about pastes, so an edit that adds more than one
 * character (a paste, a swiped or suggested word) keeps an open menu but never opens one.
 */
export function menuAfterEdit(state: ComposerMenuState, previous: string, next: string): ComposerMenuState {
  const { caret, added } = editOf(previous, next);
  const candidate = detectComposerTrigger(next, caret);
  if (isSameTrigger(state.dismissed, candidate)) return { open: null, dismissed: state.dismissed };
  if (added > 1 && !isSameTrigger(state.open, candidate)) return { open: null, dismissed: candidate };
  return { open: candidate, dismissed: null };
}

/** The menu after the caret moved without an edit: it can only close. */
export function menuAfterCaret(state: ComposerMenuState, text: string, caret: number): ComposerMenuState {
  const candidate = detectComposerTrigger(text, caret);
  return {
    open: isSameTrigger(state.open, candidate) ? candidate : null,
    dismissed: isSameTrigger(state.dismissed, candidate) ? state.dismissed : null,
  };
}
