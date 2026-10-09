import { mediaFileKind } from './mediaFile';

export type FilePreviewKind = 'video' | 'audio' | 'image' | 'pdf' | 'markdown' | 'html' | 'table' | 'structured' | 'font' | 'archive' | 'sqlite';

const KINDS = new Map<string, FilePreviewKind>([
  ...['png', 'jpg', 'jpeg', 'svg', 'webp', 'avif', 'gif', 'ico', 'bmp'].map(ext => [ext, 'image'] as const),
  ['pdf', 'pdf'], ['md', 'markdown'], ['markdown', 'markdown'], ['html', 'html'], ['htm', 'html'],
  ['csv', 'table'], ['tsv', 'table'],
  ...['json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml'].map(ext => [ext, 'structured'] as const),
  ...['ttf', 'otf', 'woff', 'woff2'].map(ext => [ext, 'font'] as const),
  ['zip', 'archive'], ['tar', 'archive'], ['sqlite', 'sqlite'], ['sqlite3', 'sqlite'], ['db', 'sqlite'],
]);

export function filePreviewKind(filePath: string): FilePreviewKind | null {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return mediaFileKind(filePath) ?? KINDS.get(ext) ?? null;
}
