import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import { PaneError, reasonOf } from '../../../../shared/paneError';

/** Reads one file of a browser tab's host page, as `panels:read-browser-file` returns it. */
export type HostFileReader = (url: string) => Promise<{ data: string }>;

const COPY_PREFIX = 'pane-page-';
const MAX_FILES = 200;
const MAX_BYTES = 64 * 1024 * 1024;
const COPY_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Relative references a page or stylesheet loads: HTML attributes, srcset candidates, CSS url() and @import.
const ATTRIBUTE_REF = /\s(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const SRCSET_REF = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_REF = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Copies a host file page and the files it references in its own folder into a new private folder on this
 * computer, and returns the copy's path. The host's reader refuses anything outside the page's folder.
 */
export async function copyHostPage(pageUrl: string, read: HostFileReader): Promise<string> {
  const page = new URL(pageUrl);
  const name = decodeURIComponent(page.pathname.slice(page.pathname.lastIndexOf('/') + 1));
  if (page.protocol !== 'file:' || !/^[^/\\]+\.html?$/i.test(name)) {
    throw new PaneError(
      'ERR_LOCAL_PAGE_BLOCKED',
      'Pane did not open this file in your browser: only .html and .htm pages open there. Nothing was opened.',
      'Open the file on the host if you trust it.',
    );
  }
  const folderUrl = new URL('./', page).href;
  const html = await read(page.href).catch((error: Error) => {
    throw new PaneError(
      'ERR_LOCAL_PAGE_MISSING',
      `Pane did not open ${name} in your browser: it could not read the page from the host (${reasonOf(error)}).`,
      'Check the host connection, reload the tab, and try again.',
    );
  });
  void pruneOldCopies();
  const folder = await mkdtemp(join(tmpdir(), COPY_PREFIX));
  const pagePath = join(folder, name);
  const pageBytes = Buffer.from(html.data, 'base64');
  await writeFile(pagePath, pageBytes);

  const queue = referencesIn(pageBytes.toString('utf8'), page.href, folderUrl);
  const copied = new Set<string>([page.href]);
  let total = pageBytes.length;
  while (queue.length > 0 && copied.size < MAX_FILES) {
    const url = queue.shift();
    if (url === undefined || copied.has(url)) continue;
    copied.add(url);
    const target = join(folder, ...decodeURIComponent(url.slice(folderUrl.length)).split('/'));
    if (!target.startsWith(folder + sep)) continue;
    // A file the host can't read stays missing in the copy, as it is in the tab.
    const file = await read(url).catch(() => null);
    if (!file) continue;
    const bytes = Buffer.from(file.data, 'base64');
    total += bytes.length;
    if (total > MAX_BYTES) break;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    if (/\.css$/i.test(new URL(url).pathname)) queue.push(...referencesIn(bytes.toString('utf8'), url, folderUrl));
  }
  return pagePath;
}

/** The URLs, in `folderUrl` and without query or fragment, of the relative references in `text`. */
function referencesIn(text: string, baseUrl: string, folderUrl: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(ATTRIBUTE_REF)) refs.push(match[1] ?? match[2] ?? match[3] ?? '');
  for (const match of text.matchAll(SRCSET_REF)) {
    for (const candidate of (match[1] ?? match[2] ?? '').split(',')) refs.push(candidate.trim().split(/\s+/)[0] ?? '');
  }
  for (const match of text.matchAll(CSS_REF)) refs.push(match.slice(1).find(value => value !== undefined) ?? '');
  const urls: string[] = [];
  for (const ref of refs) {
    // Only relative paths: no scheme, no root-relative or protocol-relative path, no in-page anchor.
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) continue;
    let url: URL;
    try {
      url = new URL(ref, baseUrl);
    } catch {
      continue;
    }
    url.search = '';
    url.hash = '';
    if (url.href.startsWith(folderUrl) && url.href.length > folderUrl.length) urls.push(url.href);
  }
  return urls;
}

/** Removes copies older than a day: the browser has long finished reading them. */
async function pruneOldCopies(): Promise<void> {
  const root = tmpdir();
  const entries = await readdir(root).catch((): string[] => []);
  await Promise.all(entries.filter(entry => entry.startsWith(COPY_PREFIX)).map(async (entry) => {
    const path = join(root, entry);
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory() && Date.now() - info.mtimeMs > COPY_LIFETIME_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
  }));
}
