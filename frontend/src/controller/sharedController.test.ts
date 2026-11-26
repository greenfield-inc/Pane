import { describe, expect, it } from 'vitest';
import { CHEAT_SHEET_SCHEME, cheatSheet, pressAction, RELEASE_ACTIONS, MINUS_TAP_ACTION, R2_HOLD_ACTION } from '../../../shared/controller/bindings';
import { pickInDirection, type Rect } from '../../../shared/controller/geometry';
import { createControllerInterpreter, type ControllerEvent } from '../../../shared/controller/interpreter';
import { nextNeedsYou, orderNeedsYou, type NeedsYouItem } from '../../../shared/controller/needsYou';
import { detectFamily, deviceFromGamepadId, keyForButton, resolveFamily } from '../../../shared/controller/profiles';
import { RESTING_AXES, type ControllerAxes, type ControllerButton, type ControllerFrame } from '../../../shared/controller/types';
import { getCatalogEntry } from '../../../shared/constants/keyboardShortcuts';

function frame(buttons: ControllerButton[] = [], axes: Partial<ControllerAxes> = {}): ControllerFrame {
  return { buttons: new Set(buttons), axes: { ...RESTING_AXES, ...axes } };
}

/** Feeds `steps` as [time ms, frame] and returns every event with its time. */
function play(steps: Array<[number, ControllerFrame]>, family: 'xbox' | 'nintendo' = 'xbox', context: 'home' | 'terminal' = 'home') {
  const interpreter = createControllerInterpreter({ family });
  const out: Array<[number, ControllerEvent]> = [];
  for (const [at, next] of steps) for (const event of interpreter.update(next, at, context)) out.push([at, event]);
  return out;
}

describe('controller interpreter', () => {
  it('runs A on press: the bottom button on an Xbox pad, the right one on a Nintendo pad', () => {
    expect(play([[0, frame(['south'])]], 'xbox')).toEqual([[0, { type: 'action', action: 'controller-activate' }]]);
    expect(play([[0, frame(['south'])]], 'nintendo')).toEqual([[0, { type: 'action', action: 'controller-back' }]]);
    expect(play([[0, frame(['east'])]], 'nintendo')).toEqual([[0, { type: 'action', action: 'controller-activate' }]]);
  });

  it('treats − released at 449 ms as a tap and held to 450 ms as the cheat sheet until release', () => {
    const select = frame(['select']);
    expect(play([[0, select], [449, frame()]])).toEqual([[449, { type: 'action', action: 'open-recent' }]]);
    expect(play([[0, select], [450, select], [900, frame()]])).toEqual([
      [450, { type: 'hold-start', action: 'show-controller-help' }],
      [900, { type: 'hold-end', action: 'show-controller-help' }],
    ]);
  });

  it('runs L1 and R1 on release, and holding both switches columns once with no tab change', () => {
    expect(play([[0, frame(['l1'])], [100, frame()]])).toEqual([[100, { type: 'action', action: 'cycle-tab-prev-a' }]]);
    expect(play([
      [0, frame(['l1'])],
      [50, frame(['l1', 'r1'])],
      [300, frame(['r1'])],
      [350, frame()],
    ])).toEqual([[50, { type: 'action', action: 'controller-switch-column' }]]);
    // Both let go in the same frame.
    expect(play([[0, frame(['l1'])], [50, frame(['l1', 'r1'])], [300, frame()]]))
      .toEqual([[50, { type: 'action', action: 'controller-switch-column' }]]);
  });

  it('holds R2 from press to release', () => {
    expect(play([[0, frame(['r2'])], [2000, frame(['r2'])], [3000, frame()]])).toEqual([
      [0, { type: 'hold-start', action: 'dictate-hold' }],
      [3000, { type: 'hold-end', action: 'dictate-hold' }],
    ]);
  });

  it('ignores the left stick inside the deadzone and repeats after 400 ms, then every 120 ms', () => {
    expect(play([[0, frame([], { leftY: 0.5 })], [1000, frame([], { leftY: 0.5 })]])).toEqual([]);
    const down = frame([], { leftY: 0.9, leftX: 0.2 });
    const times = play([[0, down], [399, down], [400, down], [519, down], [520, down], [600, frame()]]).map(([at]) => at);
    expect(times).toEqual([0, 400, 520]);
  });

  it('sends the D-pad to the terminal as arrows while the left stick still moves focus', () => {
    expect(play([[0, frame(['up'])], [10, frame(['up'], { leftX: -1 })]], 'xbox', 'terminal')).toEqual([
      [0, { type: 'action', action: 'terminal-arrow-up' }],
      [10, { type: 'action', action: 'controller-focus-left' }],
    ]);
  });

  it('scrolls with the right stick and jumps to the bottom on R3', () => {
    expect(play([[0, frame(['r3'], { rightY: 1 })]])).toEqual([
      [0, { type: 'action', action: 'jump-to-bottom' }],
      [0, { type: 'action', action: 'scroll-focused-surface-down' }],
    ]);
  });

  it('asks for clock ticks only while a timed rule is pending', () => {
    const interpreter = createControllerInterpreter({ family: 'xbox' });
    interpreter.update(frame(['south']), 0, 'home');
    expect(interpreter.needsTick()).toBe(false);
    interpreter.update(frame(['select']), 10, 'home');
    expect(interpreter.needsTick()).toBe(true);
    interpreter.update(frame(), 20, 'home');
    expect(interpreter.needsTick()).toBe(false);
  });
});

describe('controller families', () => {
  const chromium = (id: string, mapping = 'standard') => detectFamily(deviceFromGamepadId(id, mapping, true));

  it('finds the family from the ids Chromium reports', () => {
    expect(chromium('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
    expect(chromium('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(chromium('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(chromium('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(chromium('Some Pad (STANDARD GAMEPAD Vendor: 1234 Product: 5678)')).toBe('generic');
    expect(chromium('Weird Pad (Vendor: 1234 Product: 5678)', '')).toBe('unrecognised');
  });

  it('finds the family from Apple categories and Android names', () => {
    expect(detectFamily({ id: '1', name: 'Pro Controller', appleCategory: 'Switch Pro Controller', hasRumble: false })).toBe('nintendo');
    expect(detectFamily({ id: '1', name: 'DualSense', appleCategory: 'DualSense', hasRumble: true })).toBe('playstation');
    expect(detectFamily({ id: '1', name: 'Gamepad', hasRumble: false })).toBe('generic');
  });

  it('lets the override change the letters, except on a pad whose layout is unknown', () => {
    const atomXboxMode = deviceFromGamepadId('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'standard', true);
    expect(keyForButton(resolveFamily(atomXboxMode, 'auto'), 'east')).toBe('B');
    expect(keyForButton(resolveFamily(atomXboxMode, 'nintendo'), 'east')).toBe('A');
    expect(resolveFamily(deviceFromGamepadId('Weird Pad', '', false), 'xbox')).toBe('unrecognised');
  });
});

describe('cheat sheet', () => {
  it('shows each pad its own labels', () => {
    const labels = (family: 'xbox' | 'playstation' | 'nintendo') => cheatSheet(family).rows.find(row => row.label.startsWith('Open or pick'))?.keys;
    expect(labels('xbox')).toEqual(['A']);
    expect(labels('playstation')).toEqual(['✕']);
    expect(cheatSheet('playstation').rows.find(row => row.label === 'Send')?.keys).toEqual(['△']);
    expect(cheatSheet('nintendo').rows.find(row => row.label.startsWith('Hold to talk'))?.keys).toEqual(['ZR']);
  });

  it('says it cannot read an unrecognised pad', () => {
    expect(cheatSheet('unrecognised')).toMatchObject({ rows: [], note: expect.stringContaining("can't read") });
  });

  it('lists the action each button really runs, and every action is a catalog command', () => {
    for (const row of CHEAT_SHEET_SCHEME) {
      const key = row.keys[0];
      const bound = key === 'L1' || key === 'R1' ? RELEASE_ACTIONS[key]
        : key === 'minus' ? MINUS_TAP_ACTION
          : key === 'R2' ? R2_HOLD_ACTION
            : pressAction('home', key);
      expect(bound).toBe(row.action);
      expect(getCatalogEntry(row.action), row.action).toBeDefined();
    }
    expect(getCatalogEntry('send-draft')).toMatchObject({ defaultChord: null, category: 'controller' });
  });
});

describe('pickInDirection', () => {
  // Three sidebar rows stacked on the left, a tab strip across the top right, a terminal below it.
  const rows: Array<{ id: string; rect: Rect }> = [
    { id: 'row1', rect: { x: 0, y: 100, width: 200, height: 30 } },
    { id: 'row2', rect: { x: 0, y: 130, width: 200, height: 30 } },
    { id: 'row3', rect: { x: 0, y: 160, width: 200, height: 30 } },
    { id: 'tab1', rect: { x: 220, y: 0, width: 80, height: 30 } },
    { id: 'tab2', rect: { x: 300, y: 0, width: 80, height: 30 } },
    { id: 'terminal', rect: { x: 220, y: 40, width: 600, height: 400 } },
  ];
  const at = (id: string) => rows.find(row => row.id === id)!.rect;

  it('moves to the adjacent row in the same column', () => {
    expect(pickInDirection(at('row2'), rows, 'down')).toBe('row3');
    expect(pickInDirection(at('row2'), rows, 'up')).toBe('row1');
  });

  it('prefers a target sharing the row over a closer one off to the side', () => {
    expect(pickInDirection(at('row1'), rows, 'right')).toBe('terminal');
    expect(pickInDirection(at('tab1'), rows, 'right')).toBe('tab2');
  });

  it('returns null at an edge', () => {
    expect(pickInDirection(at('row1'), rows, 'left')).toBeNull();
    expect(pickInDirection(at('tab2'), rows, 'up')).toBeNull();
  });
});

describe('next needs you', () => {
  const items: NeedsYouItem[] = [
    { id: 'term-old', kind: 'terminal', since: 1 },
    { id: 'perm', kind: 'permission', since: 5 },
    { id: 'q-new', kind: 'question', since: 9 },
    { id: 'q-old', kind: 'question', since: 3 },
  ];

  it('orders questions oldest first, then permissions, then waiting terminals', () => {
    expect(orderNeedsYou(items).map(item => item.id)).toEqual(['q-old', 'q-new', 'perm', 'term-old']);
  });

  it('opens the first item, then the one after the current item, wrapping round', () => {
    expect(nextNeedsYou(items, null)?.id).toBe('q-old');
    expect(nextNeedsYou(items, 'perm')?.id).toBe('term-old');
    expect(nextNeedsYou(items, 'term-old')?.id).toBe('q-old');
    expect(nextNeedsYou([], null)).toBeNull();
  });
});
