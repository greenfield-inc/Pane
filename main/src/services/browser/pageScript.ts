/**
 * The script Pane runs in a browser tab's isolated world (docs/BROWSER_AGENTS.md). It shares the
 * page's DOM but none of its JavaScript, so a page cannot read or change the refs it hands out.
 * The first call in a document defines `globalThis.__paneBrowser` there; every call is one
 * expression on it. A new document starts empty, which is what makes refs from before a
 * navigation stale.
 */

/** The isolated world Pane's page script runs in; any id above Electron's reserved range works. */
export const PANE_WORLD_ID = 1_337;

/** Characters a snapshot keeps before it is cut off with a note. */
const SNAPSHOT_CHAR_LIMIT = 20_000;

/** What the page script's snapshot returns. */
interface PageSnapshot { snapshot: string; truncated: boolean; controlsCut: boolean; url: string; title: string }
/** What browser_wait's check returns. */
interface PageCheck { met: boolean; stale?: string }
/** The JSON values page calls take. */
type PageArgument = string | number | boolean | null | undefined | readonly string[];

function pageScript(limit: number) {
  type Entry = { el: Element; role: string; name: string };
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
  const LANDMARK = new Set(['heading', 'img', 'dialog', 'alert', 'navigation', 'main', 'form', 'table', 'row', 'cell', 'columnheader', 'list', 'listitem', 'banner', 'contentinfo', 'region', 'search', 'tablist', 'menu', 'tree', 'group', 'article']);
  const MASK = '••••••••';
  /** Elements a snapshot names or refs; a subtree without them is plain text. */
  const STRUCTURE = 'a[href],area[href],button,input,select,textarea,summary,option,img,iframe,h1,h2,h3,h4,h5,h6,nav,main,form,dialog,table,ul,ol,header,footer,article,[role],[contenteditable],[aria-label],[tabindex]';
  let generation = 0;
  let refs = new Map<string, Entry>();
  // Ref numbers count up for the life of the document and are never reused, so a ref from an
  // older snapshot (another agent's, or one before a takeover) can only miss, never hit another element.
  let counter = 0;

  function inputRole(input: HTMLInputElement): string {
    switch (input.type) {
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'button': case 'submit': case 'reset': case 'image': return 'button';
      case 'range': return 'slider';
      case 'number': return 'spinbutton';
      case 'search': return 'searchbox';
      case 'file': return 'button';
      case 'hidden': return '';
      default: return input.list ? 'combobox' : 'textbox';
    }
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (el instanceof HTMLInputElement) return inputRole(el);
    if (tag === 'textarea') return 'textbox';
    if (el instanceof HTMLSelectElement) return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'option') return 'option';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return el.getAttribute('alt') === '' ? '' : 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'article') return 'article';
    if (editable(el) && !(el.parentElement && editable(el.parentElement))) return 'textbox';
    return '';
  }

  function editable(el: Element): boolean {
    return el instanceof HTMLElement && el.isContentEditable;
  }

  function disabled(el: Element): boolean {
    return ('disabled' in el && el.disabled === true) || el.getAttribute('aria-disabled') === 'true';
  }

  /** The labels of a form control; other elements have none. */
  function labelsOf(el: Element): NodeListOf<HTMLLabelElement> | null {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement) return el.labels;
    return null;
  }

  function clean(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  function textOf(el: Element): string {
    return clean(el instanceof HTMLElement ? el.innerText : el.textContent);
  }

  /** The nodes a slot shows: what the page slotted into it, or its own fallback content. */
  function slotted(slot: HTMLSlotElement): Node[] {
    const assigned = slot.assignedNodes({ flatten: true });
    return assigned.length > 0 ? assigned : Array.from(slot.childNodes);
  }

  /** Text as rendered through slots, for a control inside a shadow root (<md-button>Save</md-button>). */
  function flatText(el: Element): string {
    let text = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) text += `${node.textContent ?? ''} `;
      else if (node instanceof HTMLSlotElement) slotted(node).forEach(walk);
      else if (node instanceof Element && !['SCRIPT', 'STYLE'].includes(node.tagName)) (node.shadowRoot ?? node).childNodes.forEach(walk);
    };
    walk(el);
    return clean(text);
  }

  function labelText(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => el.ownerDocument.getElementById(id)).filter(node => node !== null).map(node => textOf(node)).join(' ');
      if (text) return text;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labels = labelsOf(el);
    if (labels && labels.length > 0) return clean(Array.from(labels).map(label => ownText(label)).join(' '));
    return '';
  }

  /** A label's text without the text of the controls inside it (a select's options). */
  function ownText(label: Element): string {
    let text = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) text += `${node.textContent ?? ''} `;
      else if (node instanceof Element && !['SELECT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SCRIPT', 'STYLE'].includes(node.tagName)) node.childNodes.forEach(walk);
    };
    walk(label);
    return clean(text);
  }

  function nameOf(el: Element, role: string): string {
    const label = labelText(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'area' || (el instanceof HTMLInputElement && el.type === 'image')) return clean(el.getAttribute('alt'));
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value) || (el.type === 'submit' ? 'Submit' : '');
    if (['button', 'link', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'cell', 'columnheader', 'switch', 'checkbox', 'radio'].includes(role) && !['input', 'select', 'textarea'].includes(tag)) {
      return (textOf(el) || flatText(el)).slice(0, 200);
    }
    return clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder'));
  }

  function masked(el: Element): boolean {
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    const security = getComputedStyle(el).getPropertyValue('-webkit-text-security');
    return security !== '' && security !== 'none';
  }

  function valueOf(el: Element): string | undefined {
    if (el instanceof HTMLInputElement) {
      if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(el.type)) return undefined;
      if (el.type === 'file') return el.files && el.files.length > 0 ? Array.from(el.files).map(file => file.name).join(', ') : undefined;
      if (!el.value) return undefined;
      return masked(el) ? MASK : el.value;
    }
    if (el instanceof HTMLTextAreaElement) return el.value ? (masked(el) ? MASK : el.value) : undefined;
    if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions).map(option => clean(option.label || option.text)).join(', ') || undefined;
    if (editable(el)) return masked(el) ? MASK : textOf(el) || undefined;
    return undefined;
  }

  function states(el: Element, role: string): string[] {
    const out: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (role === 'heading') out.push(`level=${/^h[1-6]$/.test(tag) ? tag[1] : el.getAttribute('aria-level') ?? '2'}`);
    const input = el instanceof HTMLInputElement ? el : undefined;
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = input ? input.checked : el.getAttribute('aria-checked') === 'true';
      if (checked) out.push('checked');
    }
    if (disabled(el)) out.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') out.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (el instanceof HTMLOptionElement && el.selected)) out.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    if (('required' in el && el.required === true) || el.getAttribute('aria-required') === 'true') out.push('required');
    if (el.ownerDocument.activeElement === el) out.push('focused');
    if (input?.type === 'file') out.push('file input');
    return out;
  }

  function hidden(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true' || (el instanceof HTMLElement && el.hidden)) return true;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return true;
    // A file input styled away still takes browser_upload, so it stays in the tree.
    if (el instanceof HTMLInputElement && el.type === 'file') return false;
    // Computed style, not checkVisibility(): that also hides content-visibility: auto sections
    // (GitHub's conversation) until they scroll into view. The walk stops at a hidden parent.
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  }

  /** Names and values are cut at 300 characters, text runs at 2,000. */
  function quote(text: string, max = 300): string {
    return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
  }

  function snapshot(): PageSnapshot {
    generation += 1;
    refs = new Map();
    const lines: string[] = [];
    let size = 0;
    let truncated = false;
    // Past the text budget, the walk lists only lines with a ref (controls, headings, images) up to a
    // hard cap, so a long page stays actionable; `truncated` then says controls were cut too.
    let textFull = false;
    const hardLimit = limit * 3;
    // Elements with a shadow root somewhere inside, through nested shadow roots too: their text is
    // never collapsed into one line, or the controls inside would lose their refs.
    const shadowAncestors = new Set<Element>();
    const markShadowHosts = (root: Document | ShadowRoot) => {
      for (const host of Array.from(root.querySelectorAll('*'))) {
        if (!host.shadowRoot) continue;
        for (let parent: Element | null = host; parent;) {
          const up: Element | null = parent.parentElement ?? (parent.parentNode instanceof ShadowRoot ? parent.parentNode.host : null);
          if (!up || shadowAncestors.has(up)) break;
          shadowAncestors.add(up);
          parent = up;
        }
        markShadowHosts(host.shadowRoot);
      }
    };
    markShadowHosts(document);
    // The last line, when it is text: the next text at the same depth joins it.
    let openText: { depth: number; text: string } | null = null;
    const push = (depth: number, line: string) => {
      if (truncated) return;
      if (textFull && !line.includes('[ref=')) return;
      openText = null;
      const text = `${'  '.repeat(Math.min(depth, 20))}- ${line}`;
      if (size + text.length + 1 > hardLimit) { truncated = true; return; }
      lines.push(text);
      size += text.length + 1;
      if (size > limit) textFull = true;
    };
    const pushText = (depth: number, text: string) => {
      if (textFull) return;
      if (openText && openText.depth === depth && lines.length > 0) {
        const joined = `${openText.text} ${text}`;
        const previous = lines.pop() ?? '';
        size -= previous.length + 1;
        push(depth, `text: ${quote(joined, 2_000)}`);
        openText = { depth, text: joined };
        return;
      }
      push(depth, `text: ${quote(text, 2_000)}`);
      openText = { depth, text };
    };
    const walk = (node: Node, depth: number, inFrame: boolean) => {
      if (truncated) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = clean(node.textContent);
        if (text) pushText(depth, text);
        return;
      }
      if (!(node instanceof Element)) return;
      const tag = node.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link'].includes(tag)) return;
      if (hidden(node)) return;
      const role = roleOf(node);
      let childDepth = depth;
      if (role && (INTERACTIVE.has(role) || LANDMARK.has(role))) {
        const name = nameOf(node, role);
        const value = INTERACTIVE.has(role) ? valueOf(node) : undefined;
        let line = role + (name ? ` ${quote(name)}` : '');
        for (const state of states(node, role)) line += ` [${state}]`;
        // Inside a frame, positions are the frame's, so its elements are listed without refs.
        if (!inFrame && (INTERACTIVE.has(role) || role === 'heading' || role === 'img' || role === 'dialog')) {
          counter += 1;
          const ref = `e${counter}`;
          refs.set(ref, { el: node, role, name });
          line += ` [ref=${ref}]`;
        }
        if (value !== undefined) line += `: ${quote(value)}`;
        push(depth, line);
        childDepth = depth + 1;
        // Controls and named leaves already say what their text says.
        if (INTERACTIVE.has(role) && role !== 'listbox' && role !== 'combobox') return;
        if (role === 'heading' || role === 'img') return;
        if (role === 'combobox' && tag === 'select') return;
      }
      // A run of text with nothing to act on or name inside (a paragraph, a code block) reads as one line.
      // Nor does anything holding a slot: what the page slotted in may be controls.
      if (!role && !node.shadowRoot && !shadowAncestors.has(node) && !(node instanceof HTMLSlotElement) && !node.querySelector('slot') && !node.querySelector(STRUCTURE)) {
        const text = textOf(node);
        if (text) pushText(depth, text);
        return;
      }
      const children = node instanceof HTMLSlotElement ? slotted(node) : Array.from((node.shadowRoot ?? node).childNodes);
      for (const child of children) walk(child, childDepth, inFrame);
      if (node instanceof HTMLIFrameElement) {
        try {
          const doc = node.contentDocument;
          if (doc?.body) walk(doc.body, childDepth, true);
          else push(childDepth, 'iframe (another site; not read)');
        } catch {
          push(childDepth, 'iframe (another site; not read)');
        }
      }
    };
    if (document.body) walk(document.body, 0, false);
    return { snapshot: lines.join('\n'), truncated: truncated || textFull, controlsCut: truncated, url: location.href, title: document.title };
  }

  /** The element behind a ref, or why it can't be used. */
  function lookup(ref: string): Element | { stale: string } {
    const entry = refs.get(ref);
    if (!entry) return { stale: generation === 0 ? 'No snapshot was taken on this page yet.' : `${ref} is not in the latest snapshot (a newer snapshot or a takeover replaced it).` };
    if (!entry.el.isConnected) return { stale: `${ref} has left the page.` };
    const role = roleOf(entry.el);
    if (role !== entry.role || nameOf(entry.el, role) !== entry.name) return { stale: `${ref} was ${entry.role} "${entry.name}" and the page has changed it.` };
    return entry.el;
  }

  /** Scrolls the element into view and says where to click it, or why it can't be clicked yet. */
  /** The element under a point, through shadow roots: document.elementFromPoint stops at the host. */
  function deepestAt(x: number, y: number): Element | null {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /** Whether `inner` sits inside `outer` as the page renders it: through slots and shadow hosts. */
  function composedContains(outer: Element, inner: Element): boolean {
    for (let node: Element | null = inner; node; node = node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null)) {
      if (node === outer) return true;
    }
    return false;
  }

  function point(ref: string): { x: number; y: number } | { stale: string } | { wait: string } {
    const el = lookup(ref);
    if ('stale' in el) return el;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || hidden(el)) return { wait: `${ref} is not visible.` };
    if (disabled(el)) return { wait: `${ref} is disabled.` };
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = deepestAt(x, y);
    if (hit && hit !== el && !composedContains(el, hit) && !composedContains(hit, el) && !(el instanceof HTMLLabelElement)) {
      const label = el instanceof HTMLInputElement && Array.from(el.labels ?? []).some(candidate => composedContains(candidate, hit));
      if (!label) return { wait: `${ref} is covered by another element (${hit.tagName.toLowerCase()}).` };
    }
    return { x, y };
  }

  function focus(ref: string, clear: boolean): true | { stale: string } | { wait: string } {
    const el = lookup(ref);
    if ('stale' in el) return el;
    if (disabled(el)) return { wait: `${ref} is disabled.` };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (el instanceof HTMLElement) el.focus();
    if (clear) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
      else if (editable(el)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    return true;
  }

  function select(ref: string, values: string[]): string[] | { stale: string } | { wait: string } {
    const el = lookup(ref);
    if ('stale' in el) return el;
    if (!(el instanceof HTMLSelectElement)) return { wait: `${ref} is not a select element.` };
    const options = Array.from(el.options);
    const chosen = values.map(value => options.find(option => option.value === value) ?? options.find(option => clean(option.label || option.text) === clean(value)));
    const missing = values.filter((_, index) => !chosen[index]);
    if (missing.length > 0) return { wait: `${ref} has no option ${missing.map(value => JSON.stringify(value)).join(', ')}.` };
    for (const option of options) option.selected = chosen.includes(option);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return Array.from(el.selectedOptions).map(option => option.value);
  }

  /** Marks the element so the main world or DOM domain can find it once, by an attribute. */
  function mark(ref: string, attribute: string, token: string): true | { stale: string } {
    const el = lookup(ref);
    if ('stale' in el) return el;
    el.setAttribute(attribute, token);
    return true;
  }

  function scrollBy(ref: string | null, dx: number, dy: number): true | { stale: string } {
    if (ref === null) {
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return true;
    }
    const el = lookup(ref);
    if ('stale' in el) return el;
    if (dx === 0 && dy === 0) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    else el.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return true;
  }

  function check(text: string | null, url: string | null, ref: string | null): PageCheck {
    if (url !== null && !location.href.includes(url)) return { met: false };
    if (text !== null && !(document.body?.innerText ?? '').includes(text)) return { met: false };
    if (ref !== null) {
      const el = lookup(ref);
      if ('stale' in el) return { met: false, stale: el.stale };
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || hidden(el)) return { met: false };
    }
    return { met: true };
  }

  /** The person took over: every ref handed out so far stops working. */
  function revoke(): true {
    refs = new Map();
    return true;
  }

  /** What kind of field takes typing at `el`: a password field, another text field, or none. */
  function fieldKind(el: Element | null): 'password' | 'text' | null {
    for (let node = el; node; node = node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null)) {
      if (node instanceof HTMLInputElement) {
        if (node.disabled || node.readOnly) return null;
        if (node.type === 'password' || masked(node)) return 'password';
        return ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(node.type) ? null : 'text';
      }
      if (node instanceof HTMLTextAreaElement) return node.disabled || node.readOnly ? null : 'text';
      if (editable(node)) return 'text';
    }
    return null;
  }

  /**
   * The field that has the page's focus now, through shadow roots and same-origin frames. A field
   * in a frame Pane can't read (a payment or sign-in form) counts as a password field, so the
   * screen's keyboard learns and echoes nothing.
   */
  function focusedField(): 'password' | 'text' | null {
    let active = document.activeElement;
    for (;;) {
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (!(active instanceof HTMLIFrameElement)) return fieldKind(active);
      let inner: Document | null = null;
      try { inner = active.contentDocument; } catch { inner = null; }
      if (!inner) return 'password';
      active = inner.activeElement;
    }
  }

  /** The text the person selected, to put on their own clipboard; never a password field's. */
  function selection(): string {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      if (masked(active)) return '';
      return active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0).slice(0, 100_000);
    }
    return (window.getSelection()?.toString() ?? '').slice(0, 100_000);
  }

  return { snapshot, point, focus, select, mark, scrollBy, check, revoke, focusedField, selection };
}

/** One call on the page script, with JSON arguments; the first call in a document defines it. */
export function pageCall(method: 'snapshot' | 'point' | 'focus' | 'select' | 'mark' | 'scrollBy' | 'check' | 'revoke' | 'focusedField' | 'selection', ...args: PageArgument[]): string {
  return `(globalThis.__paneBrowser ??= (${pageScript.toString()})(${SNAPSHOT_CHAR_LIMIT})).${method}(${args.map(arg => JSON.stringify(arg ?? null)).join(', ')})`;
}
