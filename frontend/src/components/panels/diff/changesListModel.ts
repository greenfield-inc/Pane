import type { ChangedFileSummary } from '../../../../../shared/types/gitDiff';

export interface ChangesRow {
  id: string;        // the file path
  dir: string;       // 'apps/web/app/[locale]/' -- includes trailing slash, '' at repo root
  name: string;      // 'availability-bar.tsx'
  file: ChangedFileSummary;
}

export function buildChangesRows(files: ChangedFileSummary[]): ChangesRow[] {
  return [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => {
      const cut = file.path.lastIndexOf('/');
      return {
        id: file.path,
        dir: cut === -1 ? '' : file.path.slice(0, cut + 1),
        name: cut === -1 ? file.path : file.path.slice(cut + 1),
        file,
      };
    });
}

export function navigateList(rows: ChangesRow[], activeIndex: number, key: string): number {
  if (rows.length === 0) return 0;
  const index = Math.max(0, Math.min(activeIndex, rows.length - 1));
  if (key === 'ArrowDown') return Math.min(rows.length - 1, index + 1);
  if (key === 'ArrowUp') return Math.max(0, index - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return rows.length - 1;
  return index;
}

export function typeAhead(rows: ChangesRow[], activeIndex: number, buffer: string): number {
  if (!buffer || rows.length === 0) return activeIndex;
  const query = buffer.toLocaleLowerCase();
  for (let offset = 1; offset <= rows.length; offset++) {
    const index = (Math.max(activeIndex, -1) + offset) % rows.length;
    if (rows[index].name.toLocaleLowerCase().startsWith(query)) return index;
  }
  return activeIndex;
}
