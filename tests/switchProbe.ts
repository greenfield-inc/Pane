import type { Page } from '@playwright/test';
import type { SwitchMark } from '../shared/switchMarks';

declare global {
  /** The rAF probe's result for the switch in flight (armVisibleProbe below). */
  var __paneSwitchProbe: ProbeResult | undefined;
}

/**
 * When a switch's chat is on screen, timed in the page (T-87, T-116). Arm it, trigger the switch,
 * then read it. t0 is the trigger's first input event (click or keydown, capture phase).
 *
 * - visible: the first frame with the chat's composer laid out and the last message (the text
 *   `mark`) inside the conversation's scroll viewport; painted: the frame after.
 * - focused: when `focuses`, the first frame with focus in the composer.
 */
export interface ProbeResult { input?: number; visible?: number; painted?: number; focused?: number; timedOut?: boolean }

export async function armVisibleProbe(page: Page, { panelId, mark, focuses, timeoutMs = 60_000 }: { panelId: string; mark: string; focuses: boolean; timeoutMs?: number }): Promise<void> {
  await page.evaluate(({ panelId, mark, focuses, timeoutMs }) => {
    globalThis.__paneSwitchMarks = [];
    const done: ProbeResult = {};
    globalThis.__paneSwitchProbe = done;
    const started = performance.now();
    const input = (event: Event) => { done.input ??= event.timeStamp; };
    window.addEventListener('click', input, { capture: true, once: true });
    window.addEventListener('keydown', input, { capture: true, once: true });
    const laidOut = (element: Element | null | undefined) => !!element && element.getClientRects().length > 0;
    /** The last message's marker is inside the conversation's scroll viewport, not just somewhere in its text. */
    const markerOnScreen = (region: Element) => {
      if (!laidOut(region) || !region.textContent?.includes(mark)) return false;
      const viewport = region.getBoundingClientRect();
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(mark)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        return text.height > 0 && text.bottom > viewport.top && text.top < viewport.bottom;
      }
      return false;
    };
    const tick = () => {
      const now = performance.now();
      const composer = document.querySelector<HTMLTextAreaElement>(`textarea[data-chat-composer="${CSS.escape(panelId)}"]`);
      if (done.visible === undefined && laidOut(composer)) {
        if (Array.from(document.querySelectorAll('[aria-label="Conversation messages"]')).some(markerOnScreen)) done.visible = now;
      } else if (done.visible !== undefined && done.painted === undefined && now > done.visible) done.painted = now;
      if (focuses && done.focused === undefined && composer && document.activeElement === composer) done.focused = now;
      const finished = done.painted !== undefined && (!focuses || done.focused !== undefined);
      if (finished || now - started > timeoutMs) {
        done.timedOut = !finished;
        window.removeEventListener('click', input, { capture: true });
        window.removeEventListener('keydown', input, { capture: true });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { panelId, mark, focuses, timeoutMs });
}

/** Waits for the armed probe to finish (or give up after its timeout in the page), then returns it with the switch marks. */
export async function readVisibleProbe(page: Page): Promise<{ done: ProbeResult; marks: SwitchMark[] }> {
  await page.waitForFunction(() => globalThis.__paneSwitchProbe?.timedOut !== undefined, undefined, { timeout: 90_000, polling: 50 });
  return page.evaluate(() => ({ done: globalThis.__paneSwitchProbe ?? {}, marks: globalThis.__paneSwitchMarks ?? [] }));
}
