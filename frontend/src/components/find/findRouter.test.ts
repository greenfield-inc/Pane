import { describe, expect, it } from 'vitest';
import { innermostFirst, isFindRootShown, resolveFindPanelId, type FindRouteInput } from './findRouter';

/** A stand-in DOM node: a root "contains" itself and anything listed. */
function node(name: string, children: string[] = []) {
  return { contains: (other: string) => other === name || children.includes(other) };
}

const terminalRoot = node('terminal-root', ['xterm-textarea', 'terminal-bar-input']);
const previewRoot = node('preview-root', ['preview-body']);
const logsRoot = node('logs-root', ['logs-line']);

function input(overrides: Partial<FindRouteInput<string>>): FindRouteInput<string> {
  return {
    active: null,
    activeIsEditable: false,
    activeOwnsFind: false,
    targets: [
      { id: 'terminal', root: terminalRoot, visible: true },
      { id: 'preview', root: previewRoot, visible: true },
      { id: 'logs', root: logsRoot, visible: true },
    ],
    lastInteractedId: null,
    fallbackId: null,
    ...overrides,
  };
}

describe('resolveFindPanelId', () => {
  it('picks the tab that holds keyboard focus', () => {
    expect(resolveFindPanelId(input({ active: 'xterm-textarea', activeIsEditable: true, fallbackId: 'logs' }))).toBe('terminal');
  });

  it('keeps routing to the tab while focus is in its own find bar', () => {
    expect(resolveFindPanelId(input({ active: 'terminal-bar-input', activeIsEditable: true }))).toBe('terminal');
  });

  it('uses the last tab clicked when focus is on the page body (split view)', () => {
    expect(resolveFindPanelId(input({ lastInteractedId: 'preview', fallbackId: 'terminal' }))).toBe('preview');
  });

  it('falls back to the focused group active tab when the last click was elsewhere', () => {
    expect(resolveFindPanelId(input({ lastInteractedId: null, fallbackId: 'terminal' }))).toBe('terminal');
  });

  it('ignores a last-clicked tab that is no longer shown', () => {
    const targets = input({}).targets.map(t => t.id === 'preview' ? { ...t, visible: false } : t);
    expect(resolveFindPanelId(input({ targets, lastInteractedId: 'preview', fallbackId: 'logs' }))).toBe('logs');
  });

  it('leaves Cmd+F to Monaco when the code editor has focus', () => {
    expect(resolveFindPanelId(input({ active: 'monaco-textarea', activeIsEditable: true, activeOwnsFind: true, fallbackId: 'terminal' }))).toBeNull();
  });

  it('does not steal Cmd+F from a text field outside any searchable tab (Files filter, Notes)', () => {
    expect(resolveFindPanelId(input({ active: 'notes-textarea', activeIsEditable: true, lastInteractedId: 'terminal', fallbackId: 'terminal' }))).toBeNull();
  });

  it('treats a focused tab-strip button like the body and falls back', () => {
    expect(resolveFindPanelId(input({ active: 'tab-button', activeIsEditable: false, fallbackId: 'preview' }))).toBe('preview');
  });

  it('returns null when nothing is searchable', () => {
    expect(resolveFindPanelId(input({ targets: [], fallbackId: 'dashboard' }))).toBeNull();
  });
});

/** A stand-in element: laid out at `rect`, inside `parent`, holding `children`. */
interface FakeElement {
  parentNode: FakeElement | null;
  isConnected: boolean;
  children: FakeElement[];
  rect: { left: number; top: number; width: number; height: number };
  getClientRects(): ArrayLike<unknown>;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  contains(other: FakeElement): boolean;
}

function element(rect = { left: 0, top: 0, width: 10, height: 10 }, parent: FakeElement | null = null): FakeElement {
  const self: FakeElement = {
    parentNode: parent,
    isConnected: true,
    children: [],
    rect,
    getClientRects: () => (self.isConnected && self.rect.width > 0 ? [self.rect] : []),
    getBoundingClientRect: () => self.rect,
    contains: (other) => other === self || self.children.some(child => child.contains(other)),
  };
  parent?.children.push(self);
  return self;
}

describe('find roots in the page', () => {
  it('treats a tab covered by the approval column as hidden, so Cmd+F never searches what is underneath', () => {
    const page = element({ left: 0, top: 0, width: 1000, height: 800 });
    const split = element({ left: 500, top: 0, width: 500, height: 800 }, page);
    const column = element({ left: 500, top: 0, width: 500, height: 800 }, page);
    const inner = element(undefined, column);
    const hit = () => inner;
    expect(isFindRootShown(split, hit)).toBe(false);
    expect(isFindRootShown(column, hit)).toBe(true);
  });

  it('counts a root as shown when nothing can be hit-tested, and never one that is gone', () => {
    const tab = element();
    expect(isFindRootShown(tab, () => null)).toBe(true);
    tab.isConnected = false;
    expect(isFindRootShown(tab, () => null)).toBe(false);
    expect(isFindRootShown(null, () => null)).toBe(false);
  });

  it('orders nested searchable roots innermost first (a chat shown inside an approval column)', () => {
    const page = element();
    const column = element(undefined, page);
    const chat = element(undefined, element(undefined, column));
    const ordered = innermostFirst([
      { id: 'approval', root: column },
      { id: 'chat', root: chat },
      { id: 'gone', root: null },
    ]);
    expect(ordered.map(entry => entry.id)).toEqual(['chat', 'approval', 'gone']);
  });
});
