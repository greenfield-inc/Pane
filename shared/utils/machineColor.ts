/**
 * Machine colours, shared by the desktop and the phone so one machine looks the
 * same everywhere. Nothing is stored: the colour comes from the machine's name.
 */

/** Slot names in palette order; slot n uses the `machine-<n+1>` theme colour. */
export const MACHINE_COLOR_NAMES = ['Violet', 'Cyan', 'Pink', 'Lime', 'Orange', 'Rose'] as const;

export const MACHINE_COLOR_COUNT = MACHINE_COLOR_NAMES.length;

/** The slot a name asks for on its own (FNV-1a over the lowercased name). */
export function preferredMachineColorSlot(name: string): number {
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % MACHINE_COLOR_COUNT;
}

/**
 * Gives each machine name a slot. Names that ask for the same slot are settled
 * in sorted order: the earlier name keeps it and the later one takes the next
 * free slot, so the result never depends on the order machines were added.
 * Up to six names never share a slot; past six, a name keeps its own slot.
 */
export function assignMachineColorSlots(names: Iterable<string>): Map<string, number> {
  const unique = [...new Set(names)].sort((a, b) => {
    const left = a.trim().toLowerCase();
    const right = b.trim().toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const taken = new Set<number>();
  const slots = new Map<string, number>();
  for (const name of unique) {
    const preferred = preferredMachineColorSlot(name);
    let slot = preferred;
    if (taken.size < MACHINE_COLOR_COUNT) {
      while (taken.has(slot)) slot = (slot + 1) % MACHINE_COLOR_COUNT;
    }
    taken.add(slot);
    slots.set(name, slot);
  }
  return slots;
}
