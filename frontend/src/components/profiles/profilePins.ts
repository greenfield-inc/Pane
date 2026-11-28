import { useConfigStore } from '../../stores/configStore';
import { showActionError } from '../../stores/errorStore';

/**
 * Pinned profiles (T-63, build-6 feedback item 2): `plugin/profile` refs saved per user in Pane's
 * config (`pinnedProfiles`), shown first in the Profiles list and in New Session.
 */

const EMPTY: readonly string[] = [];

/** `plugin/profile` without a variant. */
function qualified(ref: string): string {
  return ref.split(':')[0];
}

export function usePinnedProfiles(): readonly string[] {
  return useConfigStore(state => state.config?.pinnedProfiles ?? EMPTY);
}

/** The pins with `ref` added (at the end) or removed. */
export function toggledPins(pins: readonly string[], ref: string): string[] {
  const name = qualified(ref);
  return pins.includes(name) ? pins.filter(pin => pin !== name) : [...pins, name];
}

/** Pinned items first, in pin order, then the rest in their own order. */
export function pinnedFirst<Item>(items: readonly Item[], pins: readonly string[], refOf: (item: Item) => string | undefined): Item[] {
  const rank = (item: Item) => {
    const ref = refOf(item);
    const index = ref ? pins.indexOf(qualified(ref)) : -1;
    return index < 0 ? pins.length : index;
  };
  return items.map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.item);
}

export function isPinned(pins: readonly string[], ref: string): boolean {
  return pins.includes(qualified(ref));
}

/**
 * Every plugin's profiles as the list and the sidebar show them (round 5): the pinned ones in pin
 * order, then the rest in Agent Farm's order.
 */
export function splitPinned<Plugin extends { profiles: readonly { ref: string }[] }>(plugins: readonly Plugin[], pins: readonly string[]) {
  const all = plugins.flatMap(plugin => plugin.profiles.map((profile: Plugin['profiles'][number]) => ({ plugin, profile })));
  return {
    pinned: pinnedFirst(all.filter(item => isPinned(pins, item.profile.ref)), pins, item => item.profile.ref),
    rest: all.filter(item => !isPinned(pins, item.profile.ref)),
  };
}

/** Pins or unpins a profile for this user. */
export function togglePinnedProfile(ref: string): void {
  const store = useConfigStore.getState();
  const next = toggledPins(store.config?.pinnedProfiles ?? EMPTY, ref);
  store.updateConfig({ pinnedProfiles: next }).catch(error => showActionError('Pane couldn\'t save the pin', error));
}
