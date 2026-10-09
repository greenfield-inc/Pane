/**
 * IPC reads for a center editor tab: text bodies, streamed read-only previews, or a binary notice and the git status badge.
 */
import { filePreviewKind, type FilePreviewKind } from '../../../../../shared/utils/filePreview';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type GitFileStatus = 'clean' | 'modified' | 'untracked';

export type EditorFileContent =
  | { kind: 'text'; content: string }
  | { kind: 'media'; mediaKind: 'video' | 'audio' }
  | { kind: 'unsupported' }
  | { kind: 'preview'; previewKind: FilePreviewKind }
  | { kind: 'error'; message: string };

export async function readEditorFile(sessionId: string, filePath: string): Promise<EditorFileContent> {
  const previewKind = filePreviewKind(filePath);
  if (previewKind === 'video' || previewKind === 'audio') return { kind: 'media', mediaKind: previewKind };
  if (previewKind) return { kind: 'preview', previewKind };
  const result = await window.electronAPI.invoke('file:read', { sessionId, filePath });
  if (result.binary) return { kind: 'unsupported' };
  if (!result.success) return { kind: 'error', message: result.error };
  return { kind: 'text', content: result.content };
}

export async function fetchGitFileStatus(sessionId: string, filePath: string): Promise<GitFileStatus | null> {
  const result: { success: boolean; data?: { status: GitFileStatus } } =
    await window.electronAPI.invoke('git:file-status', sessionId, filePath);
  return result.success && result.data ? result.data.status : null;
}
