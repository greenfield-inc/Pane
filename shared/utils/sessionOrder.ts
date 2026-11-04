/**
 * Puts the listed items in the given order within the places they already hold. Items the list
 * leaves out, and ids it names that are not present, change nothing: a list showing only some
 * Sessions (Pinned, or the active ones while others are archived) rearranges just those.
 */
export function moveWithinOwnPlaces<Item>(items: readonly Item[], orderedIds: readonly string[], idOf: (item: Item) => string): Item[] {
  const present = new Set(items.map(idOf));
  const listed = [...new Set(orderedIds)].filter(id => present.has(id));
  const moving = new Set(listed);
  const byId = new Map(items.map(item => [idOf(item), item]));
  let next = 0;
  return items.map(item => moving.has(idOf(item)) ? byId.get(listed[next++])! : item);
}
