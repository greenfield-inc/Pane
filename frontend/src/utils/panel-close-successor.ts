/** Keep the selected tab when closing in the background; otherwise prefer the right neighbour. */
export function panelCloseSuccessor(panelIds: readonly string[], activeId: string | null | undefined, closingId: string): string | null {
  if (activeId !== closingId) return activeId ?? null;
  const index = panelIds.indexOf(closingId);
  if (index < 0) return null;
  return panelIds[index + 1] ?? panelIds[index - 1] ?? null;
}
