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
type FakeListener = (event: { target: FakeNode }) => void;

/** Just enough of a page: rows with keys, a main-area button, the body, focus events and frames. */
function page() {
  const listeners = new Map<string, Set<FakeListener>>();
  const frames: Array<() => void> = [];
  const body: FakeNode = { name: 'body', isConnected: true, getAttribute: () => null, closest: () => null, focus: () => undefined };
  const doc: FakeDocument = { activeElement: body, body };
  const fire = (type: string, target: FakeNode) => listeners.get(type)?.forEach(listener => listener({ target }));
  const element = (name: string, row: boolean): FakeNode => {
    const node: FakeNode = {
      name,
      isConnected: true,
      getAttribute: (attribute: string) => (attribute === 'data-sidebar-key' && row ? name : null),
      closest: (selector: string) => (row && selector === '[data-sidebar-item]' ? node : null),
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
  return { doc, body, element, fire, nextFrame };
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

  it('keeps focus on the cursor\'s row while the switch runs, whatever takes it, and finds the row again after a re-render', async () => {
    const { doc, body, element, nextFrame } = page();
    const pressed = element('machine-session-build:release', true);
    const below = element('machine-session-build:notes', true);
    const mainButton = element('close-tile', false);
    let cursor = pressed;
    const rows = new Map([[pressed.name, pressed], [below.name, below]]);
    const switching = deferred();
    const landed = vi.fn();
    pressed.focus();
    holdCursorThroughSwitch({ switching: switching.promise, cursor: () => cursor, findByKey: key => rows.get(key) ?? null, onLanded: landed });

    // The switch's restore focuses a main-area button: focus goes straight back.
    mainButton.focus();
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
    mainButton.focus();
    expect(doc.activeElement).toBe(mainButton);
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
    const button = element('composer', false);
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
