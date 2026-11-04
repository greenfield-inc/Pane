// Turns an `expo export` folder into the files the update server serves
// (deploy/native-updates): one Expo Updates protocol v1 manifest per platform
// at updates/<runtime>/<platform>/manifest.json, and the bundle and assets
// under files/. See "Over-the-air updates" in native/README.md.
//
// Usage: node scripts/build-updates.mts --dist dist --config expo-config.json \
//   --base-url https://… --out <dir> [--created-at <ISO date>]
// createdAt defaults to the HEAD commit's committer date, so re-deploying the
// same commit gives phones nothing new. Pass --created-at for local test runs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export type Platform = 'ios' | 'android';

type ExportMetadata = {
  fileMetadata: Partial<Record<Platform, { bundle: string; assets: { path: string; ext: string }[] }>>;
};

type ManifestAsset = { hash: string; key: string; contentType: string; fileExtension: string; url: string };

export type UpdateManifest = {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ManifestAsset;
  assets: ManifestAsset[];
  metadata: Record<string, never>;
  extra: { expoClient: Record<string, unknown> };
};

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
};

const RUNTIME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();

// The client compares base64url SHA-256 of each download with `hash`.
const base64url = (digest: Buffer) => digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const toUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

export function buildManifest(options: {
  distDir: string;
  platform: Platform;
  expoConfig: Record<string, unknown>;
  baseUrl: string;
  createdAt: string;
}): UpdateManifest {
  const { distDir, platform, expoConfig, createdAt } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const runtimeVersion = expoConfig.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || !RUNTIME_PATTERN.test(runtimeVersion)) {
    throw new Error(`runtimeVersion must be a plain string matching ${RUNTIME_PATTERN} in native/app.json, got ${JSON.stringify(runtimeVersion)}.`);
  }
  const metadata = JSON.parse(readFileSync(path.join(distDir, 'metadata.json'), 'utf8')) as ExportMetadata;
  const files = metadata.fileMetadata[platform];
  if (!files) throw new Error(`${distDir}/metadata.json has no ${platform} export. Run expo export with --platform ${platform}.`);

  const describe = (relativePath: string, key: string, contentType: string, fileExtension: string): ManifestAsset => ({
    hash: base64url(sha256(readFileSync(path.join(distDir, relativePath)))),
    key,
    contentType,
    fileExtension,
    url: `${baseUrl}/files/${relativePath}`,
  });

  const bundleBytes = readFileSync(path.join(distDir, files.bundle));
  const launchAsset = describe(files.bundle, createHash('md5').update(bundleBytes).digest('hex'), 'application/javascript', '.bundle');
  // expo-asset looks assets up by Metro's file hash, which names assets/<hash>.
  const assets = files.assets.map(asset =>
    describe(asset.path, path.basename(asset.path), CONTENT_TYPES[asset.ext] ?? 'application/octet-stream', `.${asset.ext}`));

  // Stable for one commit's content, new whenever the content or createdAt changes.
  const idSource = [createdAt, runtimeVersion, platform, launchAsset.hash, ...assets.map(asset => asset.hash)].join('\n');
  return {
    id: toUuid(sha256(idSource).toString('hex')),
    createdAt,
    runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: { expoClient: expoConfig },
  };
}

// Writes updates/<runtime>/<platform>/manifest.json, and the export itself as files/.
export function writeUpdateSite(options: {
  distDir: string;
  outDir: string;
  expoConfig: Record<string, unknown>;
  baseUrl: string;
  createdAt: string;
}) {
  for (const platform of ['ios', 'android'] as const) {
    const manifest = buildManifest({ ...options, platform });
    const manifestDir = path.join(options.outDir, 'updates', manifest.runtimeVersion, platform);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest));
  }
  cpSync(options.distDir, path.join(options.outDir, 'files'), { recursive: true });
}

function headCommitDate() {
  const seconds = execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim();
  return new Date(Number(seconds) * 1000).toISOString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string', default: 'dist' },
      config: { type: 'string' },
      'base-url': { type: 'string' },
      out: { type: 'string' },
      'created-at': { type: 'string' },
    },
  });
  if (!values.config || !values['base-url'] || !values.out) {
    console.error('Usage: node scripts/build-updates.mts --dist dist --config expo-config.json --base-url <url> --out <dir> [--created-at <ISO date>]');
    process.exit(1);
  }
  const createdAt = values['created-at'] ? new Date(values['created-at']).toISOString() : headCommitDate();
  const expoConfig = JSON.parse(readFileSync(values.config, 'utf8')) as Record<string, unknown>;
  writeUpdateSite({ distDir: values.dist, outDir: values.out, expoConfig, baseUrl: values['base-url'], createdAt });
  console.log(`Wrote runtime ${String(expoConfig.runtimeVersion)} updates (createdAt ${createdAt}) to ${values.out}`);
}
