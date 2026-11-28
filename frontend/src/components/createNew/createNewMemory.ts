/** What Create New remembers on this computer between opens (T-63). */
const MODE_KEY = 'pane.new.mode';
const TO_KEY = 'pane.new.to';

export type CreateNewMode = 'session' | 'pane';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Without storage, Create New opens as a Session on Claude next time.
  }
}

/** Session or Pane, as Create was last switched to; a Session the first time. */
export function rememberedMode(): CreateNewMode {
  return read(MODE_KEY) === 'pane' ? 'pane' : 'session';
}

export function rememberMode(mode: CreateNewMode): void {
  write(MODE_KEY, mode);
}

/** The To choice of the last Session created here (`agent:claude`, `profile:greenfield/orchestrator`). */
export function rememberedTo(): string | null {
  return read(TO_KEY);
}

export function rememberTo(key: string): void {
  write(TO_KEY, key);
}

/** The images a chat can take with a message, as the chat composer sends them. */
export const ATTACHABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export interface ImageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** The picked file, which goes into the chat's draft if the first send fails. */
  file: File;
  /** Base64, without the `data:` prefix. */
  data: string;
}

export function isAttachableImage(file: { type: string }): boolean {
  return ATTACHABLE_IMAGE_TYPES.some(type => type === file.type);
}

/** Reads a picked, pasted or dropped image for the first message, as base64. */
export async function readImageAttachment(file: File): Promise<ImageAttachment> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name || 'The image'} could not be read. Attach it again.`);
  }
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return { id: crypto.randomUUID(), name: file.name || 'pasted-image', size: file.size, mimeType: file.type, file, data: btoa(binary) };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
