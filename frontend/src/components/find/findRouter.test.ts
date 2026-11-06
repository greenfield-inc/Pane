import { describe, expect, it } from 'vitest';
import { resolveFindPanelId, type FindRouteInput } from './findRouter';

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
