/**
 * Opens (or re-targets) the session's Browser panel at an HTML file.
 */
import { boundary, decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { openUrlInSessionBrowser } from '../../../services/browserPanelNavigation';

const filePathResponseSchema = boundary.object({
  success: boundary.boolean,
  url: boundary.optional(boundary.string),
  error: boundary.optional(boundary.string),
});

export async function previewHtmlFileInBrowser(sessionId: string, filePath: string): Promise<void> {
  const result = decodeBoundary(
    await window.electronAPI.invoke('file:getPath', { sessionId, filePath }),
    filePathResponseSchema,
  );
  if (!result.success || !result.url) {
    throw new Error(result.error || 'Failed to resolve HTML preview URL');
  }

  await openUrlInSessionBrowser(sessionId, result.url, { title: filePath.split('/').pop() || 'Browser' });
}
