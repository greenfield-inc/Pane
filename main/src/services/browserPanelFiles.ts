import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserPanelState, ToolPanel, ToolPanelState } from '../../../shared/types/panels';
import { isRemotePaneCommand } from '../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { hasFileProtocol } from '../../../shared/utils/browserUrl';

const browserUrlSchema = boundary.object({ currentUrl: boundary.optional(boundary.string) });

/** File entry URLs are host-owned grants; remote panel edits cannot create them. */
export function assertHostBrowserFileNavigation(type: string, nextState: ToolPanelState, previousState?: ToolPanelState): void {
  if (type !== 'browser' || !isRemotePaneCommand()) return;
  const next = decodeBoundary(nextState.customState ?? {}, browserUrlSchema).currentUrl;
  const previous = decodeBoundary(previousState?.customState ?? {}, browserUrlSchema).currentUrl;
  if (!next || next === previous) return;
  if (hasFileProtocol(next)) throw new Error('Open or change this file preview on the host');
}

interface ContentTypeByExtension { [extension: string]: string }
const CONTENT_TYPES: ContentTypeByExtension = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

/** Read only within the directory of an existing browser panel's host entry page. */
export async function readBrowserPanelFile(panel: ToolPanel | undefined, requestedUrl: string) {
  // SAFETY: Only browser panels carry BrowserPanelState.
  const entryUrl = panel?.type === 'browser'
    ? (panel.state.customState as BrowserPanelState | undefined)?.currentUrl : undefined;
  if (!entryUrl || !hasFileProtocol(entryUrl)) throw new Error('No host file is open in this browser panel');
  const entryPath = fileURLToPath(entryUrl);
  if (!(await fs.stat(entryPath)).isFile()) throw new Error('The host entry page is not a regular file');
  const root = await fs.realpath(path.dirname(entryPath));
  const requestedPath = await fs.realpath(fileURLToPath(requestedUrl));
  const relative = path.relative(root, requestedPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('File is outside the opened browser bundle');
  }
  const file = await fs.open(requestedPath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
      throw new Error('Browser bundle files must be regular files no larger than 16 MiB');
    }
    return {
      data: (await file.readFile()).toString('base64'),
      contentType: CONTENT_TYPES[path.extname(requestedPath).toLowerCase()] ?? 'application/octet-stream',
    };
  } finally {
    await file.close();
  }
}
