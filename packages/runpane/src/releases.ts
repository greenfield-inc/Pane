import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { ArtifactFormat } from './commands';
import type { BoundarySchema, JsonObject } from './boundaryDecoder';
import { archAliases, defaultFormat, platformParam, type PanePlatform } from './platform';

const GITHUB_API_BASE = 'https://api.github.com/repos/greenfield-inc/Pane/releases';
const DOWNLOAD_API_BASE = 'https://runpane.com/api/download';
/** A cached lookup younger than this is used without asking GitHub again. */
export const RELEASE_CACHE_FRESH_MS = 60 * 60 * 1000;
/** When GitHub can't be reached, a cached lookup younger than this stands in for it. */
export const RELEASE_CACHE_FALLBACK_MS = 24 * 60 * 60 * 1000;
const RELEASE_CACHE_VERSION = 1;

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets?: GitHubReleaseAsset[];
}

const githubReleaseSchema: BoundarySchema<GitHubRelease> = boundary.object({
  tag_name: boundary.string,
  name: boundary.string,
  body: boundary.string,
  html_url: boundary.string,
  published_at: boundary.string,
  prerelease: boundary.boolean,
  draft: boundary.boolean,
  assets: boundary.optional(boundary.array(boundary.object({
    name: boundary.string,
    browser_download_url: boundary.string,
  }))),
});

export interface ResolvedRelease {
  release: GitHubRelease;
  /** Set when the lookup went through `cacheFile`. */
  lookup?: ReleaseLookup;
  artifact: GitHubReleaseAsset;
  format: Exclude<ArtifactFormat, 'auto'>;
  preferredDownloadUrl: string;
  fallbackDownloadUrl: string;
  checksumUrl: string;
}

export interface ResolveReleaseOptions {
  version: string;
  channel: 'stable' | 'nightly';
  source: 'npm' | 'pip';
  platform: PanePlatform;
  format: ArtifactFormat;
  target: 'client' | 'daemon';
  fetchTimeoutMs?: number;
  /** Reuse a recent lookup saved here instead of asking GitHub on every run (see `fetchReleaseCached`). */
  cacheFile?: string;
  now?: () => number;
}

export async function resolveRelease(options: ResolveReleaseOptions): Promise<ResolvedRelease> {
  const lookup = options.cacheFile
    ? await fetchReleaseCached(options.version, { cacheFile: options.cacheFile, timeoutMs: options.fetchTimeoutMs, now: options.now })
    : undefined;
  const release = lookup ? lookup.release : await fetchRelease(options.version, options.fetchTimeoutMs);
  const format = options.format === 'auto' ? defaultFormat(options.platform, options.target) : options.format;
  const artifact = findArtifact(release, options.platform, format);
  const preferredDownloadUrl = buildPreferredDownloadUrl(options, format, release);

  const resolved: ResolvedRelease = {
    release,
    artifact,
    format,
    preferredDownloadUrl,
    fallbackDownloadUrl: artifact.browser_download_url,
    checksumUrl: `https://github.com/greenfield-inc/Pane/releases/download/${release.tag_name}/SHA256SUMS.txt`
  };
  if (lookup) resolved.lookup = lookup;
  return resolved;
}

export async function fetchRelease(version: string, timeoutMs?: number): Promise<GitHubRelease> {
  const normalized = version === 'latest' ? 'latest' : version.startsWith('v') ? `tags/${version}` : `tags/v${version}`;
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;

  try {
    const response = await fetch(`${GITHUB_API_BASE}/${normalized}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'runpane-installer',
        ...githubAuthHeaders()
      },
      signal: controller?.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Pane release ${version}: ${response.status} ${response.statusText}`.trimEnd());
    }

    const release = decodeBoundary(await response.json(), githubReleaseSchema);
    if (release.draft || release.prerelease) {
      throw new Error(`Release ${release.tag_name} is not a stable public release.`);
    }
    return release;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out fetching Pane release ${version} after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * The GitHub token from `GH_TOKEN`, else `GITHUB_TOKEN`, so API calls count against the person's
 * 5,000 an hour instead of the 60 an hour GitHub gives each unauthenticated address. Never printed.
 */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function githubAuthHeaders(): Record<string, string> {
  const token = githubToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface ReleaseLookup {
  release: GitHubRelease;
  /** True when the release came from the cache file rather than from GitHub on this run. */
  cached: boolean;
  /** When GitHub returned this release, as an ISO timestamp. */
  fetchedAt: string;
  /** Set when GitHub failed on this run and an older cached lookup stands in for it. */
  refreshError?: string;
}

interface ReleaseCacheEntry {
  fetchedAt: string;
  release: GitHubRelease;
}

interface ReleaseCacheFile {
  version: number;
  entries: Record<string, ReleaseCacheEntry>;
}

const releaseCacheEntrySchema: BoundarySchema<ReleaseCacheEntry> = boundary.object({
  fetchedAt: boundary.string,
  release: githubReleaseSchema,
});

const releaseCacheFileSchema = boundary.object({
  version: boundary.number,
  entries: boundary.jsonObject,
});

export interface CachedReleaseOptions {
  cacheFile: string;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * `fetchRelease` behind a small on-disk cache. A lookup younger than `RELEASE_CACHE_FRESH_MS` is
 * reused without a request. Otherwise GitHub is asked; a good answer replaces the cached one, and
 * a failure falls back to a cached lookup younger than `RELEASE_CACHE_FALLBACK_MS` (with
 * `refreshError` set), or throws when there is none. Reading or writing the cache never fails the lookup.
 */
export async function fetchReleaseCached(version: string, options: CachedReleaseOptions): Promise<ReleaseLookup> {
  const now = options.now ?? Date.now;
  const entry = readReleaseCacheEntry(options.cacheFile, version);
  const age = entry ? now() - Date.parse(entry.fetchedAt) : Number.NaN;
  if (entry && age >= 0 && age < RELEASE_CACHE_FRESH_MS) {
    return { release: entry.release, cached: true, fetchedAt: entry.fetchedAt };
  }
  try {
    const release = await fetchRelease(version, options.timeoutMs);
    const fetchedAt = new Date(now()).toISOString();
    writeReleaseCacheEntry(options.cacheFile, version, { fetchedAt, release });
    return { release, cached: false, fetchedAt };
  } catch (error) {
    if (entry && age >= 0 && age < RELEASE_CACHE_FALLBACK_MS) {
      return {
        release: entry.release,
        cached: true,
        fetchedAt: entry.fetchedAt,
        refreshError: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

function readReleaseCacheFile(cacheFile: string): ReleaseCacheFile | undefined {
  let parsed: { version: number; entries: JsonObject };
  try {
    parsed = decodeBoundary(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), releaseCacheFileSchema);
  } catch {
    return undefined;
  }
  if (parsed.version !== RELEASE_CACHE_VERSION) return undefined;
  const entries: Record<string, ReleaseCacheEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    try {
      entries[key] = decodeBoundary(value, releaseCacheEntrySchema);
    } catch {
      // A malformed entry is a cache miss for that version only.
    }
  }
  return { version: parsed.version, entries };
}

function readReleaseCacheEntry(cacheFile: string, version: string): ReleaseCacheEntry | undefined {
  return readReleaseCacheFile(cacheFile)?.entries[version];
}

function writeReleaseCacheEntry(cacheFile: string, version: string, entry: ReleaseCacheEntry): void {
  const file = readReleaseCacheFile(cacheFile) ?? { version: RELEASE_CACHE_VERSION, entries: {} };
  file.entries[version] = entry;
  const partial = `${cacheFile}.${process.pid}.partial`;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`);
    fs.renameSync(partial, cacheFile);
  } catch {
    // The cache only saves requests; a read-only Pane directory just means the next run asks GitHub again.
    fs.rmSync(partial, { force: true });
  }
}

export function findArtifact(
  release: GitHubRelease,
  platform: PanePlatform,
  format: Exclude<ArtifactFormat, 'auto'>
): GitHubReleaseAsset {
  const assets = release.assets ?? [];
  const aliases = archAliases(platform);
  const candidates = assets.filter((asset) => matchesFormat(asset.name, format) && matchesPlatform(asset.name, platform));
  const exact = candidates.find((asset) => aliases.some((alias) => lowerName(asset).includes(alias.toLowerCase())));
  const universal = candidates.find((asset) => lowerName(asset).includes('universal'));
  const selected = exact ?? universal ?? candidates[0];

  if (!selected) {
    const assetNames = assets.map((asset) => asset.name).join(', ') || 'no assets';
    throw new Error(`No Pane ${format} asset found for ${platform.os}/${platform.arch} in ${release.tag_name}. Assets: ${assetNames}`);
  }

  return selected;
}

export function artifactFileName(urlOrName: string): string {
  return path.basename(urlOrName.split('?')[0]);
}

function buildPreferredDownloadUrl(
  options: ResolveReleaseOptions,
  format: Exclude<ArtifactFormat, 'auto'>,
  release: GitHubRelease
): string {
  const params = new URLSearchParams({
    platform: platformParam(options.platform),
    arch: options.platform.arch,
    format,
    version: release.tag_name,
    channel: options.channel,
    source: options.source
  });
  return `${DOWNLOAD_API_BASE}?${params.toString()}`;
}

function matchesFormat(name: string, format: Exclude<ArtifactFormat, 'auto'>): boolean {
  const lower = name.toLowerCase();
  if (format === 'appimage') return lower.endsWith('.appimage');
  return lower.endsWith(`.${format}`);
}

function matchesPlatform(name: string, platform: PanePlatform): boolean {
  const lower = name.toLowerCase();
  if (platform.os === 'darwin') return lower.includes('macos') || lower.includes('darwin') || lower.includes('mac');
  if (platform.os === 'win32') return lower.includes('windows') || /(?:^|[._-])win(?:32|64)?(?:[._-]|$)/.test(lower);
  return lower.includes('linux');
}

function lowerName(asset: GitHubReleaseAsset): string {
  return asset.name.toLowerCase();
}
