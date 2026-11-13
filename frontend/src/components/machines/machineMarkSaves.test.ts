import { describe, expect, it } from 'vitest';
import type { MachineMarkOverrides } from '../../../../shared/utils/machineMarks';
import { applyMarkChange, createMarkSaver } from './machineMarkSaves';

/** A config store whose writes land only after `release` is called, like a slow config round trip. */
function slowStore(initial: MachineMarkOverrides) {
  let marks = initial;
  const pending: Array<() => void> = [];
  return {
    read: () => marks,
    write: (next: MachineMarkOverrides) => new Promise<void>((resolve) => {
      pending.push(() => { marks = next; resolve(); });
    }),
    releaseNext: async () => {
      // Let the queued save reach its write before releasing it.
      for (let tick = 0; tick < 5 && pending.length === 0; tick += 1) await Promise.resolve();
      pending.shift()?.();
      await Promise.resolve();
    },
    get marks() { return marks; },
    get pending() { return pending.length; },
  };
}

describe('applyMarkChange', () => {
  it('sets a non-empty override and removes an empty one', () => {
    expect(applyMarkChange({}, 'a', (current) => ({ ...current, letters: 'AB' }))).toEqual({ a: { letters: 'AB' } });
    expect(applyMarkChange({ a: { letters: 'AB' }, b: { color: 'Lime' } }, 'a', () => ({}))).toEqual({ b: { color: 'Lime' } });
  });
});

describe('createMarkSaver', () => {
  it('keeps letters typed before a colour pick whose save started while the letters were still saving', async () => {
    const store = slowStore({});
    const save = createMarkSaver({ read: store.read, write: store.write });
    const letters = save('travel', (current) => ({ ...current, letters: 'AB' }));
    const color = save('travel', (current) => ({ ...current, color: 'Lime' }));
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    // Only one write is in flight at a time.
    expect(store.pending).toBe(1);
    await store.releaseNext();
    await store.releaseNext();
    await Promise.all([letters, color]);
    expect(store.marks).toEqual({ travel: { letters: 'AB', color: 'Lime' } });
  });

  it('runs the next save after a failed one, from the persisted marks', async () => {
    let marks: MachineMarkOverrides = {};
    let fail = true;
    const save = createMarkSaver({
      read: () => marks,
      write: async (next) => {
        if (fail) { fail = false; throw new Error('disk full'); }
        marks = next;
      },
    });
    await expect(save('a', () => ({ letters: 'X' }))).rejects.toThrow('disk full');
    await save('b', () => ({ color: 'Lime' }));
    expect(marks).toEqual({ b: { color: 'Lime' } });
  });
});
