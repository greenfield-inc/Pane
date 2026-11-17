import { formatTimeLeft, uploadToHost, type UploadFile, type UploadInvoke, type UploadProgress } from '../../../shared/chunkedUpload';
import { bytesToBase64 } from '../../../shared/utils/base64';

export interface HostUploadOptions {
  invoke: UploadInvoke;
  file: File;
  sessionId: string;
  /** The file keeps its own name on the host (a chat attachment). */
  keepName?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

/**
 * Copies a file to the Pane's machine (this computer or a connected one) and
 * returns its path there. It goes in chunks that resume after a dropped
 * connection, so any size the host has room for gets there.
 */
export function uploadFileToHost({ invoke, file, sessionId, keepName, signal, onProgress }: HostUploadOptions): Promise<string> {
  return uploadToHost({ invoke, file: browserUploadFile(file), sessionId, uploadId: createUploadId(), keepName, signal, onProgress });
}

/** Desktop has no quick MD5 of a large file; size and offsets guard the upload, and TLS the bytes. */
function browserUploadFile(file: File): UploadFile {
  return {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    md5: '',
    read: async (offset, length) => bytesToBase64(new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())),
  };
}

function createUploadId(): string {
  return `desktop-${crypto.randomUUID().replace(/-/g, '')}`;
}

/** "42%", "42% · about 3 min left" ("42% · 3 min" when `short`), or "Reconnecting · 42%": how a copy to the host is going. */
export function describeUpload(progress: UploadProgress, { short = false }: { short?: boolean } = {}): string {
  const percent = `${progress.totalBytes > 0 ? Math.floor((progress.receivedBytes / progress.totalBytes) * 100) : 0}%`;
  if (progress.retrying) return `Reconnecting · ${percent}`;
  return [percent, formatTimeLeft(progress.secondsLeft, { short })].filter(Boolean).join(' · ');
}
