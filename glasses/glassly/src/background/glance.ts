// The glance: what glasses too small (or without swipes) for the full app show, read-only.
import type { PaneSource } from '../../../src/model';

export function glanceText(source: PaneSource): string {
  const waiting = source.cards().filter((card) => card.waiting);
  const newest = waiting[0];
  if (!newest) return 'Pane · nothing needs you';
  return `Pane · ${waiting.length} need${waiting.length === 1 ? 's' : ''} you\n${newest.machine}: ${newest.title}`;
}
