import { describe, expect, it } from 'vitest';
import { assignMachineColorSlots, preferredMachineColorSlot } from '../../../shared/utils/machineColor';

// FNV-1a 32-bit reference vectors: "a" = 0xe40c292c, "foobar" = 0xbf9cf968.
// Both are 4 mod 6, which makes them a ready-made clash.
describe('machine colour slots', () => {
  it('derives the slot from the name, ignoring case and spaces', () => {
    expect(preferredMachineColorSlot('a')).toBe(4);
    expect(preferredMachineColorSlot('foobar')).toBe(4);
    expect(preferredMachineColorSlot(' FooBar ')).toBe(4);
  });

  it('settles a clash in sorted order, whatever order the names arrive in', () => {
    const expected = new Map([['a', 4], ['foobar', 5]]);
    expect(assignMachineColorSlots(['a', 'foobar'])).toEqual(expected);
    expect(new Map([...assignMachineColorSlots(['foobar', 'a'])].sort())).toEqual(expected);
  });

  it('gives six machines six different colours', () => {
    const names = ['studio-mac', 'build-box', 'office-pc', 'travel-laptop', 'cloud-vm', 'a'];
    const slots = assignMachineColorSlots(names);
    expect(new Set(slots.values()).size).toBe(6);
  });
});
