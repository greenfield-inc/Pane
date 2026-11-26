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

import { useRef, useState } from 'react';
import { detectComposerTrigger, isSameTrigger, type ComposerTrigger } from '../../../../shared/composerMentions';

/** The trigger whose menu is open, with the text it was found in: a draft changed from outside closes it. */
interface Open { trigger: ComposerTrigger | null; text: string }

/** Edits open the menu unless Escape dismissed its word; caret moves and pastes only close it. */
export function useComposerTrigger(draft: string) {
  const [open, setOpen] = useState<Open>({ trigger: null, text: '' });
  // Key handlers read this before React commits the state.
  const openRef = useRef(open);
  const dismissedRef = useRef<ComposerTrigger | null>(null);
  const activate = (trigger: ComposerTrigger | null, text: string) => {
    openRef.current = { trigger, text };
    setOpen(openRef.current);
  };
  /** The trigger at the caret when its menu is the open one, otherwise null. */
  const keep = (candidate: ComposerTrigger | null) => isSameTrigger(openRef.current.trigger, candidate) ? candidate : null;

  return {
    trigger: open.text === draft ? open.trigger : null,
    edited: (text: string, caret: number, pasted: boolean) => {
      const candidate = detectComposerTrigger(text, caret);
      if (pasted) {
        const kept = keep(candidate);
        // Typing on after a paste does not open a menu for the pasted word either.
        if (!kept) dismissedRef.current = candidate;
        activate(kept, text);
        return;
      }
      if (isSameTrigger(dismissedRef.current, candidate)) { activate(null, text); return; }
      dismissedRef.current = null;
      activate(candidate, text);
    },
    caretMoved: (text: string, start: number, end: number) => {
      const candidate = start === end ? detectComposerTrigger(text, start) : null;
      if (!isSameTrigger(dismissedRef.current, candidate)) dismissedRef.current = null;
      activate(keep(candidate), text);
    },
    dismiss: () => {
      dismissedRef.current = openRef.current.trigger;
      activate(null, openRef.current.text);
    },
  };
}
