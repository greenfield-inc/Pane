import type { ToolPanel } from '../../../shared/types/panels';

function tabTypeOrder(type: ToolPanel['type']): number {
  if (type === 'explorer') return 0;
  if (type === 'diff') return 1;
  if (type === 'browser') return 2;
  return 3;
}

/** Keep visible tabs and their numbered shortcuts in the same order. */
export function sortTabBarPanels(panels: ToolPanel[]): ToolPanel[] {
  return [...panels].sort((a, b) =>
    tabTypeOrder(a.type) - tabTypeOrder(b.type)
      || (a.metadata.position ?? 0) - (b.metadata.position ?? 0));
}
