/**
 * A window's accessibility tree as text, with element ids that stay the same across reads, and
 * diffs against the last tree the agent saw. Pure and engine-agnostic: an engine adapter turns
 * its own tree into `UiElement`s.
 */

/** One element as the engine reports it, in depth-first order (a parent comes before its children). */
export interface UiElement {
  /** The engine's handle for acting on this element in the current snapshot; absent for display-only rows. */
  ref?: string;
  role: string;
  label?: string;
  value?: string;
  /** Accessibility actions beyond a plain click, by display name ("Show Menu"). */
  actions: string[];
  /** Flags worth showing, such as "focused", "selected" or "disabled". */
  states: string[];
  /** Index of the parent in the same array, or null for a root. */
  parent: number | null;
}

interface Node {
  id: number;
  parentId: number;
  element: UiElement;
}

const ROOT_ID = 0;
const MAX_VALUE_CHARS = 200;
/** A diff longer than this share of the full tree (or this many lines) gives way to the full tree. */
const DIFF_SHARE_LIMIT = 0.5;
const MIN_DIFF_LINE_LIMIT = 30;

export class WindowTree {
  private current: Node[] = [];
  private shown: Map<number, Node> | null = null;
  private nextId = 1;

  /** Takes a new snapshot of the window. Elements that match one from the last snapshot keep its id. */
  update(elements: UiElement[]): void {
    const previousChildren = groupByParent(this.current);
    const nodes: Node[] = new Array(elements.length);
    const newChildren = new Map<number | null, number[]>();
    elements.forEach((element, index) => {
      const key = element.parent !== null && element.parent < index ? element.parent : null;
      const list = newChildren.get(key) ?? [];
      list.push(index);
      newChildren.set(key, list);
    });

    // Top-down, so each element's parent already has its id. Among one parent's children, an
    // exact role and label match wins first; then the same role in order (a label or value changed).
    const assign = (parentIndex: number | null, parentId: number) => {
      const children = newChildren.get(parentIndex) ?? [];
      const candidates = [...(previousChildren.get(parentId) ?? [])];
      const ids = new Array<number | undefined>(children.length);
      const take = (predicate: (node: Node, element: UiElement) => boolean) => {
        children.forEach((childIndex, i) => {
          if (ids[i] !== undefined) return;
          const element = elements[childIndex];
          const at = candidates.findIndex((node) => predicate(node, element));
          if (at === -1) return;
          ids[i] = candidates[at].id;
          candidates.splice(at, 1);
        });
      };
      take((node, element) => node.element.role === element.role && node.element.label === element.label);
      // Only where the label is the value itself (engines fall back to it), so a stale id never
      // moves to a different control that happens to share the role, like OK becoming Delete.
      take((node, element) => node.element.role === element.role && (labelIsValue(node.element) || labelIsValue(element)));
      children.forEach((childIndex, i) => {
        const id = ids[i] ?? this.nextId++;
        nodes[childIndex] = { id, parentId, element: elements[childIndex] };
        assign(childIndex, id);
      });
    };
    assign(null, ROOT_ID);
    this.current = nodes;
  }

  has(id: number): boolean {
    return this.current.some((node) => node.id === id);
  }

  /** The engine handle for an element id in the latest snapshot. */
  refFor(id: number): string | undefined {
    return this.current.find((node) => node.id === id)?.element.ref;
  }

  /** The text an element holds in the latest snapshot. */
  valueFor(id: number): string | undefined {
    return this.current.find((node) => node.id === id)?.element.value;
  }

  /**
   * Renders the latest snapshot for the agent: the changes since the last render, or the full tree
   * on the first read, when asked, or when the diff would be too long. Marks it as seen.
   */
  render(options: { full?: boolean } = {}): string {
    const shown = this.shown;
    this.shown = new Map(this.current.map((node) => [node.id, node]));
    const fullLines = this.fullLines();
    if (!shown || options.full) return fullLines.join('\n');

    const diff = this.diffLines(shown);
    if (diff.length === 0) return 'No changes since the last read.';
    const limit = Math.max(MIN_DIFF_LINE_LIMIT, fullLines.length * DIFF_SHARE_LIMIT);
    if (diff.length - 1 > limit) return ['Too much changed to list; the full tree follows.', ...fullLines].join('\n');
    return diff.join('\n');
  }

  private fullLines(): string[] {
    const depth = new Map<number, number>([[ROOT_ID, -1]]);
    return this.current.map((node) => {
      const level = (depth.get(node.parentId) ?? -1) + 1;
      depth.set(node.id, level);
      return `${'  '.repeat(level)}${describe(node)}`;
    });
  }

  private diffLines(shown: Map<number, Node>): string[] {
    const currentIds = new Set(this.current.map((node) => node.id));
    const added: string[] = [];
    const changed: string[] = [];
    for (const node of this.current) {
      const before = shown.get(node.id);
      if (!before) {
        added.push(`+ ${describe(node)}`);
      } else if (describe(before) !== describe(node)) {
        const was = before.element.value !== node.element.value ? ` (was ${quote(before.element.value ?? '')})` : '';
        changed.push(`~ ${describe(node)}${was}`);
      }
    }

    // A removed subtree is listed once, at its top.
    const removedIds = new Set([...shown.keys()].filter((id) => !currentIds.has(id)));
    const inside = new Map<number, number>();
    for (const id of removedIds) {
      let parentId = shown.get(id)?.parentId ?? ROOT_ID;
      let top: number | null = null;
      while (removedIds.has(parentId)) {
        top = parentId;
        parentId = shown.get(parentId)?.parentId ?? ROOT_ID;
      }
      if (top !== null) inside.set(top, (inside.get(top) ?? 0) + 1);
    }
    const removed = [...shown.values()]
      .filter((node) => removedIds.has(node.id) && !removedIds.has(node.parentId))
      .map((node) => {
        const count = inside.get(node.id);
        return `- ${describe(node)}${count ? ` (and ${count} inside it)` : ''}`;
      });

    const lines = [...added, ...removed, ...changed];
    if (lines.length === 0) return [];
    return [`Changes since the last read: ${added.length} added, ${removed.length} removed, ${changed.length} changed.`, ...lines];
  }
}

function labelIsValue(element: UiElement): boolean {
  return !element.label || element.label === element.value;
}

function groupByParent(nodes: Node[]): Map<number, Node[]> {
  const groups = new Map<number, Node[]>();
  for (const node of nodes) {
    const list = groups.get(node.parentId) ?? [];
    list.push(node);
    groups.set(node.parentId, list);
  }
  return groups;
}

function quote(text: string): string {
  const flat = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
  return JSON.stringify(flat);
}

function describe(node: Node): string {
  const { role, label, value, states, actions } = node.element;
  let line = `${node.id} ${role}`;
  if (label) line += ` ${quote(label)}`;
  if (value !== undefined && value !== '' && value !== label) line += ` value=${quote(value)}`;
  if (states.length > 0) line += ` (${states.join(', ')})`;
  if (actions.length > 0) line += ` · Secondary Actions: ${actions.join(', ')}`;
  return line;
}
