const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Bytes as people read them on cards and in Resources: "13 GB", "2.4 GB", "980 MB", "879 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 10 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(0, Math.round(bytes / KB))} KB`;
}

export const formatMB = (mb: number): string => formatBytes(mb * MB);
