/**
 * The script that puts a saved login into a page (docs/BROWSER_AGENTS.md). It runs in an isolated
 * world made for one fill, so the page's scripts can't change what it checks. Pane's main process
 * holds a handle to that world, which Chromium drops with the document: a page that navigates
 * between the check and the fill gets nothing.
 */

/** The attribute that hands the ref's element from the snapshot's world to this one, for one check. */
export const LOGIN_MARK = 'data-pane-login';

/** What the check answers: the document's own origin, or why the field can't take a login. */
interface LoginCheck { origin: string; problem?: string }
/** What the fill answers: why nothing (or not everything) went in. */
interface LoginFill { problem?: string }

function loginWorld() {
  const TYPES = new Set(['text', 'password', 'email', 'tel', 'number', 'search', 'url']);
  const ARMED_MS = 2_000;
  let target: HTMLInputElement | null = null;

  const parentOf = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);

  function findMarked(root: Document | ShadowRoot, mark: string, token: string): Element | null {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.getAttribute(mark) === token) return el;
      const inner = el.shadowRoot ? findMarked(el.shadowRoot, mark, token) : null;
      if (inner) return inner;
    }
    return null;
  }

  /** This document's origin; "null" when its URL and its security origin differ (a sandboxed or srcdoc page). */
  function origin(): string {
    return self.origin === location.origin ? self.origin : 'null';
  }

  function hitAt(x: number, y: number): Element | null {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /** Why a person couldn't type in this element now, or null when they could. */
  function untypeable(el: Element): string | null {
    if (!(el instanceof HTMLInputElement) || !TYPES.has(el.type)) return 'is not a text or password field';
    if (!el.isConnected) return 'has left the page';
    if (el.matches(':disabled') || el.readOnly || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) return 'is disabled or read-only';
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    let opacity = 1;
    for (let node: Element | null = el; node; node = parentOf(node)) opacity *= Number(getComputedStyle(node).opacity);
    const rect = el.getBoundingClientRect();
    if (opacity < 0.1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || rect.width < 8 || rect.height < 8) return 'is hidden';
    const y = rect.top + rect.height / 2;
    const reachable = [0.5, 0.25, 0.75].some(part => {
      const hit = hitAt(rect.left + rect.width * part, y);
      return hit === el || (hit !== null && Array.from(el.labels ?? []).some(label => label.contains(hit)));
    });
    return reachable ? null : 'is off screen or covered by something else';
  }

  function check(mark: string, token: string): LoginCheck {
    const el = findMarked(document, mark, token);
    el?.removeAttribute(mark);
    if (!el) return { origin: origin(), problem: 'has left the page' };
    const problem = untypeable(el);
    if (problem || !(el instanceof HTMLInputElement)) return { origin: origin(), problem: problem ?? 'is not a text or password field' };
    target = el;
    return { origin: origin() };
  }

  /** Whether this input is one box of a split PIN: it takes one character, or is as narrow as one. */
  function oneCharacter(el: HTMLInputElement): boolean {
    if (el.maxLength === 1) return true;
    const rect = el.getBoundingClientRect();
    return el.maxLength < 0 && rect.width <= 80 && rect.width < rect.height * 1.6;
  }

  /** The split PIN's boxes in page order: the smallest group around `el` with exactly one box per character. */
  function boxesAround(el: HTMLInputElement, length: number): HTMLInputElement[] | null {
    for (let scope = parentOf(el); scope; scope = parentOf(scope)) {
      const boxes = Array.from(scope.querySelectorAll('input')).filter(input => TYPES.has(input.type) && oneCharacter(input));
      if (boxes.length === length && boxes.includes(el)) return boxes;
      if (boxes.length > length || scope instanceof HTMLFormElement) return null;
    }
    return null;
  }

  /** The field shows dots, can't be copied, and stays so however the page changes it. */
  function protect(el: HTMLInputElement): void {
    if (el.type !== 'password') el.type = 'password';
    new MutationObserver(() => { if (el.type !== 'password') el.type = 'password'; }).observe(el, { attributes: true, attributeFilter: ['type'] });
  }

  /** Text the page copies from the login (a PIN component's drawn digits, a "show" preview) shows as dots too. */
  function concealCopies(value: string, boxes: readonly HTMLInputElement[]): void {
    const armedUntil = Date.now() + ARMED_MS;
    const conceal = (el: Element | null) => {
      if (!(el instanceof HTMLElement) || boxes.some(box => box === el)) return;
      const dots = () => {
        if (el.style.getPropertyValue('-webkit-text-security') === 'disc') return;
        el.style.setProperty('-webkit-text-security', 'disc', 'important');
        el.style.setProperty('user-select', 'none', 'important');
      };
      dots();
      new MutationObserver(dots).observe(el, { attributes: true, attributeFilter: ['style'] });
    };
    const inspect = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? '').replace(/\s+/g, '');
        // A drawn digit is one or two characters of the value, just after the fill; the whole value counts any time.
        const copied = text.includes(value) || (text !== '' && text.length <= 2 && value.includes(text) && Date.now() < armedUntil);
        if (copied) conceal(node.parentElement);
      } else if (node instanceof Element) {
        node.childNodes.forEach(inspect);
        if ((node.textContent ?? '').replace(/\s+/g, '') === value) conceal(node);
      }
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') inspect(record.target);
        else record.addedNodes.forEach(inspect);
      }
    });
    const roots = new Set<Node>([document, ...boxes.map(box => box.getRootNode())]);
    for (const root of roots) observer.observe(root, { subtree: true, childList: true, characterData: true });
  }

  /** Puts `text` in the field as typing would: focused, one input event the page's framework sees, then change. */
  function enter(el: HTMLInputElement, text: string): void {
    const key = text.length === 1 ? text : 'Unidentified';
    el.focus({ preventScroll: true });
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fill(value: string, sites: readonly string[]): Promise<LoginFill> {
    if (!target || !sites.includes(origin())) return { problem: 'is on a page that changed site' };
    const problem = untypeable(target);
    if (problem) return { problem };
    const characters = Array.from(value);
    const boxes = oneCharacter(target) && characters.length > 1 ? boxesAround(target, characters.length) : null;
    if (!boxes && target.maxLength >= 0 && target.maxLength < value.length) return { problem: 'does not fit this login' };
    const fields = boxes ?? [target];
    if (fields.some(field => untypeable(field) !== null)) return { problem: 'is one of several boxes, and another of them can\'t be typed in' };
    fields.forEach(protect);
    concealCopies(value, fields);
    if (!boxes) {
      enter(target, value);
      return {};
    }
    for (const [index, character] of characters.entries()) {
      // The page may have redrawn the boxes or moved one out of reach after the last character.
      if (untypeable(boxes[index]) !== null) return { problem: 'is one of several boxes, and the page changed them partway, so only some were filled' };
      enter(boxes[index], character);
      // The page's framework applies each box's change before the next, as with a person's keys.
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return {};
  }

  return { check, fill };
}

/** The expression that builds the world's script; its result is the handle the driver calls. */
export function loginWorldScript(): string {
  return `(${loginWorld.toString()})()`;
}
