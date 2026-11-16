import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

export interface RemotePwaAssetResponse {
  handled: boolean;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

interface RemotePwaAssetOptions {
  distRoot?: string;
}

interface ContentTypeByExtension {
  [extension: string]: string;
}

const REMOTE_PWA_PREFIX = '/app';

const CONTENT_TYPES: ContentTypeByExtension = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * The app's origin holds every saved computer's token. Only its own files may run scripts in it,
 * and no other site may frame it: every `<id>.runpane.net` counts as the same site to a browser.
 */
const APP_SECURITY_HEADERS = {
  'Content-Security-Policy': "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function isRemotePwaPath(pathname: string): boolean {
  return pathname === REMOTE_PWA_PREFIX || pathname.startsWith(`${REMOTE_PWA_PREFIX}/`);
}

export async function getRemotePwaAssetResponse(
  pathname: string,
  options: RemotePwaAssetOptions = {},
): Promise<RemotePwaAssetResponse> {
  if (!isRemotePwaPath(pathname)) {
    return { handled: false };
  }

  if (pathname === REMOTE_PWA_PREFIX) {
    return {
      handled: true,
      statusCode: 308,
      headers: {
        Location: `${REMOTE_PWA_PREFIX}/`,
      },
      body: '',
    };
  }

  const distRoot = options.distRoot ?? findRemotePwaDistRoot();
  if (!distRoot) {
    return remotePwaNotFound('Remote Pane PWA has not been built yet.');
  }

  const indexPath = getRemotePwaIndexPath(distRoot);
  if (!indexPath) {
    return remotePwaNotFound('Remote Pane PWA entrypoint was not found.');
  }

  const relativePath = getRelativePwaPath(pathname);
  if (!relativePath) {
    return readAsset(indexPath, 'no-cache');
  }

  const requestedPath = path.resolve(distRoot, relativePath);
  if (!isPathInside(distRoot, requestedPath)) {
    return remotePwaNotFound('Remote Pane PWA asset path is invalid.');
  }

  const stat = await statFile(requestedPath);
  if (stat?.isFile()) {
    return readAsset(requestedPath, 'public, max-age=31536000, immutable');
  }

  return readAsset(indexPath, 'no-cache');
}

function findRemotePwaDistRoot(): string | null {
  const { resourcesPath } = decodeBoundary(process, boundary.object({
    resourcesPath: boundary.optional(boundary.string),
  }));
  const candidates = [
    process.env.PANE_REMOTE_PWA_DIST,
    resourcesPath
      ? path.resolve(resourcesPath, 'app/frontend/dist')
      : undefined,
    path.resolve(__dirname, '../../../frontend/dist'),
    path.resolve(__dirname, '../../../../frontend/dist'),
    path.resolve(__dirname, '../../../../../frontend/dist'),
    // Last: Pane started from inside a checkout must not serve that checkout's files as the app.
    path.resolve(process.cwd(), 'frontend/dist'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

function getRemotePwaIndexPath(distRoot: string): string | null {
  const candidates = [
    path.join(distRoot, 'remote.html'),
    path.join(distRoot, 'remote', 'index.html'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function getRelativePwaPath(pathname: string): string | null {
  const rawPath = pathname.slice(`${REMOTE_PWA_PREFIX}/`.length);
  if (rawPath.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function statFile(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

async function readAsset(filePath: string, cacheControl: string): Promise<RemotePwaAssetResponse> {
  const body = await fs.promises.readFile(filePath);
  return {
    handled: true,
    statusCode: 200,
    headers: {
      'Cache-Control': cacheControl,
      'Content-Length': String(body.byteLength),
      'Content-Type': getContentType(filePath),
      ...APP_SECURITY_HEADERS,
    },
    body,
  };
}

function remotePwaNotFound(message: string): RemotePwaAssetResponse {
  return {
    handled: true,
    statusCode: 404,
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: message,
  };
}

function getContentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
