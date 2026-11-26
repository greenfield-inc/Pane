import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginMachineSwitch, holdCursorThroughSwitch, machineSwitchInFlight, releaseSwitchCursorHold } from './switchCursorHold';

interface FakeNode {
  name: string;
  isConnected: boolean;
  getAttribute(attribute: string): string | null;
  closest(selector: string): FakeNode | null;
  focus(): void;
}
interface FakeDocument { activeElement: FakeNode; body: FakeNode }
interface FakeEvent { target: FakeNode; key?: string; metaKey?: boolean }
type FakeListener = (event: FakeEvent) => void;

/** Just enough of a page: rows with keys, a main-area button, the body, focus events and frames. */
function page() {
  const listeners = new Map<string, Set<FakeListener>>();
  const frames: Array<() => void> = [];
  const body: FakeNode = { name: 'body', isConnected: true, getAttribute: () => null, closest: () => null, focus: () => undefined };
  const doc: FakeDocument = { activeElement: body, body };
  const fire = (type: string, target: FakeNode, key?: string, metaKey?: boolean) => listeners.get(type)?.forEach(listener => listener({ target, key, metaKey }));
  /** `kind` places a non-row element: a text field, or inside a dialog (the palette is both). */
  const element = (name: string, row: boolean, kind?: 'field' | 'dialog'): FakeNode => {
    const node: FakeNode = {
      name,
      isConnected: true,
      getAttribute: (attribute: string) => (attribute === 'data-sidebar-key' && row ? name : null),
      closest: (selector: string) => {
        if (row) return selector.includes('[data-sidebar-item]') ? node : null;
        if (kind === 'field') return selector.includes('textarea') ? node : null;
        if (kind === 'dialog') return selector.includes('[aria-modal="true"]') ? node : null;
        return null;
      },
      focus: () => { doc.activeElement = node; fire('focusin', node); },
    };
    return node;
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: FakeListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: FakeListener) => listeners.get(type)?.delete(listener),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const nextFrame = () => frames.splice(0).forEach(callback => callback());
  /** A listener another part of the page adds, such as a dialog's focus trap. */
  const listen = (type: string, listener: FakeListener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(listener);
  };
  return { doc, body, element, fire, nextFrame, listen };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the cursor through a switch to another machine (T-128, D-6)', () => {
  beforeEach(() => releaseSwitchCursorHold());
  afterEach(() => {
    releaseSwitchCursorHold();
    vi.unstubAllGlobals();
  });

  it('puts focus back on the cursor\'s row only when it was lost to the body, also after the row re-rendered', async () => {
    const { doc, body, element, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const below = element('machine-session-build:notes', true);
    let cursor = pressed;
    const rows = new Map([[pressed.name, pressed], [below.name, below]]);
    const switching = deferred();
    const landed = vi.fn();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => cursor, findByKey: key => rows.get(key) ?? null, onLanded: landed });

    // The switch's restore clears the host's rows: focus falls to the body and comes back next frame.
    doc.activeElement = body;
    nextFrame();
    expect(doc.activeElement).toBe(pressed);

    // The person arrows on (the sidebar moves its cursor); then the host's list re-renders that row away.
    below.focus();
    cursor = below;
    const rerendered = element(below.name, true);
    below.isConnected = false;
    rows.set(below.name, rerendered);
    doc.activeElement = body;
    nextFrame();
    expect(doc.activeElement).toBe(rerendered);

    // The cursor moved on, so the landing leaves focus where the person put it.
    switching.resolve();
    await settled();
    expect(landed).not.toHaveBeenCalled();
  });

  // Review F-1: the hold never takes focus from anywhere the person, or a dialog, put it.
  it('keeps focus in the command palette the person opened with mod+K', async () => {
    const { doc, element, fire, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const paletteInput = element('command-palette-input', false, 'field');
    const switching = deferred();
    const landed = vi.fn();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => pressed, findByKey: () => pressed, onLanded: landed });

    fire('keydown', pressed, 'k');
    paletteInput.focus();
    nextFrame();
    expect(doc.activeElement.name).toBe('command-palette-input');
    switching.resolve();
    await settled();
    expect(doc.activeElement.name).toBe('command-palette-input');
    expect(landed).not.toHaveBeenCalled();
  });

  it('keeps focus in a field that took it without a key press, and does not move into the work over it', async () => {
    const { doc, element, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const composer = element('composer', false, 'field');
    const switching = deferred();
    const landed = vi.fn();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => pressed, findByKey: () => pressed, onLanded: landed });

    composer.focus();
    nextFrame();
    expect(doc.activeElement).toBe(composer);
    switching.resolve();
    await settled();
    expect(doc.activeElement).toBe(composer);
    expect(landed).not.toHaveBeenCalled();
  });

  it('does not fight a modal focus trap (the stack-overflow repro)', async () => {
    const { doc, element, listen, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const dialogButton = element('dialog-button', false, 'dialog');
    const switching = deferred();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });
    // The trap: whenever focus lands outside the dialog, it focuses the dialog again.
    let bounces = 0;
    listen('focusin', (event) => {
      if (event.target !== dialogButton && bounces < 1000) { bounces += 1; dialogButton.focus(); }
    });

    dialogButton.focus();
    nextFrame();
    nextFrame();
    expect(bounces).toBe(0);
    expect(doc.activeElement).toBe(dialogButton);
    switching.resolve();
    await settled();
  });

  it('lets go once the person types anything but the sidebar\'s own keys, so a later blur is not undone', async () => {
    const { doc, body, element, fire, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const switching = deferred();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });

    fire('keydown', pressed, 'ArrowDown');
    doc.activeElement = body;
    nextFrame();
    expect(doc.activeElement).toBe(pressed);

    fire('keydown', pressed, 'Tab');
    doc.activeElement = body;
    nextFrame();
    expect(doc.activeElement).toBe(body);
    switching.resolve();
    await settled();
  });

  // Review F-5 (#1767 Bug 2, first half): a focus move the switch made, with no key or click from
  // the person, goes back to the cursor's row at once, so the next arrow press still moves it.
  it('brings focus back from a main-area button the switch focused, before the next press', async () => {
    const { doc, element, fire, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const below = element('machine-session-build:notes', true);
    const closeTile = element('close-tile', false);
    let cursor = pressed;
    const switching = deferred();
    const landed = vi.fn();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => cursor, findByKey: () => cursor, onLanded: landed });

    // The restore focuses a tile's button that stays on screen: back on the row with no frame waited.
    closeTile.focus();
    expect(doc.activeElement).toBe(pressed);
    nextFrame(); nextFrame();
    expect(doc.activeElement).toBe(pressed);

    // An arrow press reaches the sidebar, which moves the cursor; then the old tile's "Retry" fallback
    // takes focus as it renders, and it comes back to the new cursor row.
    fire('keydown', pressed, 'ArrowDown');
    below.focus();
    cursor = below;
    element('retry', false).focus();
    expect(doc.activeElement).toBe(below);

    switching.resolve();
    await settled();
    expect(landed).not.toHaveBeenCalled();
  });

  it('leaves a main-area button the person clicked or tabbed to', async () => {
    const { doc, element, fire } = page();
    const pressed = element('machine-session-build:release', true);
    const button = element('close-tile', false);
    pressed.focus();
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });
    fire('mousedown', button);
    button.focus();
    expect(doc.activeElement).toBe(button);

    pressed.focus();
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });
    fire('keydown', pressed, 'Tab');
    button.focus();
    expect(doc.activeElement).toBe(button);
  });

  it('lets go on mod+K, so a plain button the palette focuses is the person\'s', () => {
    const { doc, element, fire } = page();
    const pressed = element('machine-session-build:release', true);
    const button = element('palette-action', false);
    pressed.focus();
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });
    fire('keydown', pressed, 'k', true);
    button.focus();
    expect(doc.activeElement).toBe(button);
  });

  it('keeps a dialog the app opened by itself, with no key press', async () => {
    const { doc, element, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const approval = element('approval-dialog', false, 'dialog');
    pressed.focus();
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });
    approval.focus();
    nextFrame();
    expect(doc.activeElement).toBe(approval);
  });

  it('lets go, instead of looping, when something outside a dialog takes focus straight back', async () => {
    const { doc, element, listen, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const grabby = element('custom-trap', false);
    pressed.focus();
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => pressed, findByKey: () => pressed, onLanded: vi.fn() });
    let bounces = 0;
    listen('focusin', (event) => {
      if (event.target !== grabby && bounces < 1000) { bounces += 1; grabby.focus(); }
    });

    grabby.focus();
    nextFrame();
    expect(bounces).toBeLessThanOrEqual(1);
    expect(doc.activeElement).toBe(grabby);
    // Released: a later move isn't undone.
    pressed.focus();
    grabby.focus();
    expect(doc.activeElement).toBe(grabby);
  });

  it('moves into the work when the switch ends with the cursor still on the pressed row', async () => {
    const { element } = page();
    const pressed = element('machine-session-build:release', true);
    const switching = deferred();
    const landed = vi.fn();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => pressed, findByKey: () => pressed, onLanded: landed });

    switching.resolve();
    await settled();
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it('a hung switch never holds the cursor up, and a click or a newer Enter ends the hold', async () => {
    const { doc, element, fire } = page();
    const rows = ['a', 'b', 'c', 'd'].map(name => element(`row-${name}`, true));
    let cursor = rows[0];
    const landed = vi.fn();
    rows[0].focus();
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => cursor, findByKey: () => null, onLanded: landed });

    for (const row of rows.slice(1)) {
      row.focus();
      cursor = row;
      expect(doc.activeElement).toBe(row);
    }

    // A click is the person choosing where focus goes.
    fire('mousedown', rows[3]);
    const button = element('composer', false, 'field');
    button.focus();
    expect(doc.activeElement).toBe(button);

    // A newer hold replaces an older one, which then never moves focus.
    const older = deferred();
    const olderLanded = vi.fn();
    rows[0].focus();
    holdCursorThroughSwitch({ switching: older.promise, cursor: () => rows[0], findByKey: () => null, onLanded: olderLanded });
    holdCursorThroughSwitch({ switching: new Promise(() => undefined), cursor: () => rows[0], findByKey: () => null, onLanded: landed });
    older.resolve();
    await settled();
    expect(olderLanded).not.toHaveBeenCalled();
    expect(landed).not.toHaveBeenCalled();
  });

  it('tracks the newest switch from its press until it ends', () => {
    expect(machineSwitchInFlight()).toBeNull();
    const endFirst = beginMachineSwitch();
    const first = machineSwitchInFlight();
    const endSecond = beginMachineSwitch();
    expect(machineSwitchInFlight()).not.toBe(first);
    endFirst();
    expect(machineSwitchInFlight()).not.toBeNull();
    endSecond();
    expect(machineSwitchInFlight()).toBeNull();
  });
});
