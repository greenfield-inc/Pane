import path from 'path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { ArtifactFormat } from './commands';
import type { BoundarySchema } from './boundaryDecoder';
import { archAliases, defaultFormat, platformParam, type PanePlatform } from './platform';

const GITHUB_API_BASE = 'https://api.github.com/repos/greenfield-inc/Pane/releases';
const DOWNLOAD_API_BASE = 'https://runpane.com/api/download';

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
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
}

export async function resolveRelease(options: ResolveReleaseOptions): Promise<ResolvedRelease> {
  const release = await fetchRelease(options.version, options.fetchTimeoutMs);
  const format = options.format === 'auto' ? defaultFormat(options.platform, options.target) : options.format;
  const artifact = findArtifact(release, options.platform, format);
  const preferredDownloadUrl = buildPreferredDownloadUrl(options, format, release);

  return {
    release,
    artifact,
    format,
    preferredDownloadUrl,
    fallbackDownloadUrl: artifact.browser_download_url,
    checksumUrl: `https://github.com/greenfield-inc/Pane/releases/download/${release.tag_name}/SHA256SUMS.txt`
  };
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
        'user-agent': 'runpane-installer'
      },
      signal: controller?.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Pane release ${version}: ${response.status} ${response.statusText}`);
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
