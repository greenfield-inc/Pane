import { ChunkedUploadUnsupportedError, formatTimeLeft, uploadInChunks, type UploadFile, type UploadInvoke, type UploadProgress } from '../../../shared/chunkedUpload';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/** Hosts from before chunked upload take one request of at most 16 MB, base64 included. */
const SINGLE_REQUEST_MAX_BYTES = 12 * 1024 * 1024;

export interface HostUploadOptions {
  invoke: UploadInvoke;
  file: File;
  sessionId: string;
  /** The file keeps its own name on the host (a chat attachment). */
  keepName?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

const savedSchema = boundary.object({ filePath: boundary.nonEmptyString });

/**
 * Copies a file to the Pane's machine (this computer or a connected one) and
 * returns its path there. It goes in chunks that resume after a dropped
 * connection, so any size the host has room for gets there.
 */
export async function uploadFileToHost({ invoke, file, sessionId, keepName, signal, onProgress }: HostUploadOptions): Promise<string> {
  try {
    return await uploadInChunks({ invoke, file: browserUploadFile(file), sessionId, uploadId: createUploadId(), keepName, signal, onProgress });
  } catch (error) {
    if (!(error instanceof ChunkedUploadUnsupportedError)) throw error;
    return uploadInOneRequest(invoke, file, sessionId, keepName);
  }
}

/** The single request an older host takes. */
async function uploadInOneRequest(invoke: UploadInvoke, file: File, sessionId: string, keepName?: boolean): Promise<string> {
  if (file.size > SINGLE_REQUEST_MAX_BYTES) {
    throw new Error(`The Pane on that computer takes files up to 12 MB, and ${file.name} is larger. Update Pane there to send files of any size.`);
  }
  const mimeType = file.type || 'application/octet-stream';
  const dataUrl = `data:${mimeType};base64,${await readBase64(file, 0, file.size)}`;
  const reply = file.type.startsWith('image/') && !keepName
    ? await invoke('terminal:paste-image', ['', sessionId, dataUrl, mimeType])
    : await invoke('terminal:paste-file', keepName ? [sessionId, dataUrl, file.name, { keepName: true }] : [sessionId, dataUrl, file.name]);
  return decodeBoundary(reply, savedSchema).filePath;
}

/** Desktop has no quick MD5 of a large file; size and offsets guard the upload, and TLS the bytes. */
function browserUploadFile(file: File): UploadFile {
  return {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    md5: '',
    read: (offset, length) => readBase64(file, offset, length),
  };
}

async function readBase64(file: File, offset: number, length: number): Promise<string> {
  const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  let binary = '';
  // In 32 KiB slices, so a large chunk never builds one huge argument list.
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function createUploadId(): string {
  return `desktop-${crypto.randomUUID().replace(/-/g, '')}`;
}

/** "42%", "42% · about 3 min left", or "Reconnecting · 42%": how a copy to the host is going. */
export function describeUpload(progress: UploadProgress): string {
  const percent = `${progress.totalBytes > 0 ? Math.floor((progress.receivedBytes / progress.totalBytes) * 100) : 0}%`;
  if (progress.retrying) return `Reconnecting · ${percent}`;
  return [percent, formatTimeLeft(progress.secondsLeft)].filter(Boolean).join(' · ');
}
