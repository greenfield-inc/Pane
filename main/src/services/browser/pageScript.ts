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
export const SNAPSHOT_CHAR_LIMIT = 20_000;

function pageScript(limit: number) {
  type Entry = { el: Element; role: string; name: string };
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
  const LANDMARK = new Set(['heading', 'img', 'dialog', 'alert', 'navigation', 'main', 'form', 'table', 'row', 'cell', 'columnheader', 'list', 'listitem', 'banner', 'contentinfo', 'region', 'search', 'tablist', 'menu', 'tree', 'group', 'article']);
  const MASK = '••••••••';
  let generation = 0;
  let refs = new Map<string, Entry>();

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
    if (tag === 'input') return inputRole(el as HTMLInputElement);
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
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
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return 'textbox';
    return '';
  }

  function clean(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  function textOf(el: Element): string {
    return clean((el as HTMLElement).innerText ?? el.textContent);
  }

  function labelText(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => el.ownerDocument.getElementById(id)).filter(Boolean).map(node => textOf(node as Element)).join(' ');
      if (text) return text;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labels = (el as HTMLInputElement).labels;
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
    if (tag === 'img' || tag === 'area' || (tag === 'input' && (el as HTMLInputElement).type === 'image')) return clean(el.getAttribute('alt'));
    if (tag === 'input' && ['submit', 'button', 'reset'].includes((el as HTMLInputElement).type)) return clean((el as HTMLInputElement).value) || ((el as HTMLInputElement).type === 'submit' ? 'Submit' : '');
    if (['button', 'link', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'cell', 'columnheader', 'switch', 'checkbox', 'radio'].includes(role) && !['input', 'select', 'textarea'].includes(tag)) {
      return textOf(el).slice(0, 200);
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
    if ((el as HTMLElement).isContentEditable) return masked(el) ? MASK : textOf(el) || undefined;
    return undefined;
  }

  function states(el: Element, role: string): string[] {
    const out: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (role === 'heading') out.push(`level=${/^h[1-6]$/.test(tag) ? tag[1] : el.getAttribute('aria-level') ?? '2'}`);
    const input = el as HTMLInputElement;
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = tag === 'input' ? input.checked : el.getAttribute('aria-checked') === 'true';
      if (checked) out.push('checked');
    }
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') out.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (el instanceof HTMLOptionElement && el.selected)) out.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') out.push('required');
    if (el.ownerDocument.activeElement === el) out.push('focused');
    if (tag === 'input' && input.type === 'file') out.push('file input');
    return out;
  }

  function hidden(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return true;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return true;
    // A file input styled away still takes browser_upload, so it stays in the tree.
    if (el instanceof HTMLInputElement && el.type === 'file') return false;
    return typeof el.checkVisibility === 'function' ? !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : false;
  }

  function quote(text: string): string {
    return JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}…` : text);
  }

  function snapshot(): { snapshot: string; truncated: boolean; url: string; title: string } {
    generation += 1;
    refs = new Map();
    const lines: string[] = [];
    let size = 0;
    let truncated = false;
    let counter = 0;
    const push = (depth: number, line: string) => {
      if (truncated) return;
      const text = `${'  '.repeat(Math.min(depth, 20))}- ${line}`;
      if (size + text.length + 1 > limit) { truncated = true; return; }
      lines.push(text);
      size += text.length + 1;
    };
    const walk = (node: Node, depth: number) => {
      if (truncated) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = clean(node.textContent);
        if (text) push(depth, `text: ${quote(text)}`);
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
        if (INTERACTIVE.has(role) || role === 'heading' || role === 'img' || role === 'dialog') {
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
      const root = (node as HTMLElement).shadowRoot;
      for (const child of Array.from((root ?? node).childNodes)) walk(child, childDepth);
      if (tag === 'iframe') {
        try {
          const doc = (node as HTMLIFrameElement).contentDocument;
          if (doc?.body) walk(doc.body, childDepth);
          else push(childDepth, 'iframe (another site; not read)');
        } catch {
          push(childDepth, 'iframe (another site; not read)');
        }
      }
    };
    if (document.body) walk(document.body, 0);
    return { snapshot: lines.join('\n'), truncated, url: location.href, title: document.title };
  }

  /** The element behind a ref, or why it can't be used. */
  function lookup(ref: string): Element | { stale: string } {
    const entry = refs.get(ref);
    if (!entry) return { stale: generation === 0 ? 'No snapshot was taken on this page yet.' : `There is no ${ref} in the last snapshot.` };
    if (!entry.el.isConnected) return { stale: `${ref} has left the page.` };
    const role = roleOf(entry.el);
    if (role !== entry.role || nameOf(entry.el, role) !== entry.name) return { stale: `${ref} was ${entry.role} "${entry.name}" and the page has changed it.` };
    return entry.el;
  }

  /** Scrolls the element into view and says where to click it, or why it can't be clicked yet. */
  function point(ref: string): { x: number; y: number } | { stale: string } | { wait: string } {
    const el = lookup(ref);
    if ('stale' in el) return el;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || hidden(el)) return { wait: `${ref} is not visible.` };
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return { wait: `${ref} is disabled.` };
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el instanceof HTMLLabelElement)) {
      const label = el instanceof HTMLInputElement && Array.from(el.labels ?? []).some(candidate => candidate.contains(hit));
      if (!label) return { wait: `${ref} is covered by another element (${hit.tagName.toLowerCase()}).` };
    }
    return { x, y };
  }

  function focus(ref: string, clear: boolean): true | { stale: string } | { wait: string } {
    const el = lookup(ref);
    if ('stale' in el) return el;
    if ((el as HTMLInputElement).disabled) return { wait: `${ref} is disabled.` };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    (el as HTMLElement).focus();
    if (clear) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
      else if ((el as HTMLElement).isContentEditable) {
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
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
      return true;
    }
    const el = lookup(ref);
    if ('stale' in el) return el;
    if (dx === 0 && dy === 0) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    else el.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
    return true;
  }

  function check(text: string | null, url: string | null, ref: string | null): { met: boolean; stale?: string } {
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

  return { snapshot, point, focus, select, mark, scrollBy, check };
}

/** One call on the page script, with JSON arguments; the first call in a document defines it. */
export function pageCall(method: 'snapshot' | 'point' | 'focus' | 'select' | 'mark' | 'scrollBy' | 'check', ...args: unknown[]): string {
  return `(globalThis.__paneBrowser ??= (${pageScript.toString()})(${SNAPSHOT_CHAR_LIMIT})).${method}(${args.map(arg => JSON.stringify(arg ?? null)).join(', ')})`;
}
