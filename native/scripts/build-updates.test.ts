import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildManifest, type UpdateManifest } from './build-updates.mjs';

const script = path.join(__dirname, 'build-updates.mts');
const expoConfig = { name: 'Pane', slug: 'pane', runtimeVersion: '1.2', version: '1.2' };
const baseUrl = 'https://updates.example.test/';
const createdAt = '2026-10-28T12:00:00.000Z';

let dist: string;

beforeEach(() => {
  dist = mkdtempSync(path.join(tmpdir(), 'pane-export-'));
  mkdirSync(path.join(dist, '_expo/static/js/ios'), { recursive: true });
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, '_expo/static/js/ios/entry-abc.hbc'), 'console.log(1)');
  writeFileSync(path.join(dist, 'assets/0123456789abcdef0123456789abcdef'), 'PNGDATA');
  const files = { bundle: '_expo/static/js/ios/entry-abc.hbc', assets: [{ path: 'assets/0123456789abcdef0123456789abcdef', ext: 'png' }] };
  writeFileSync(path.join(dist, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { ios: files, android: files } }));
});

describe('buildManifest', () => {
  it('describes the export the way expo-updates verifies it', () => {
    const manifest = buildManifest({ distDir: dist, platform: 'ios', expoConfig, baseUrl, createdAt });

    // Hashes are base64url SHA-256 of the bytes, from `openssl dgst -sha256 -binary | base64`.
    expect(manifest.launchAsset).toEqual({
      hash: 'CihokcEcBW4atb_CW_XWsvWwbTjqwQlE9nj9ii5ww5M',
      key: '6114f5adc373accd7b2051bd87078f62',
      contentType: 'application/javascript',
      fileExtension: '.bundle',
      url: 'https://updates.example.test/files/_expo/static/js/ios/entry-abc.hbc',
    });
    expect(manifest.assets).toEqual([{
      hash: 'LUVmWChEaQ-GNKiyU06lIhVgA4xsBlDJkUB1m61gOuI',
      key: '0123456789abcdef0123456789abcdef',
      contentType: 'image/png',
      fileExtension: '.png',
      url: 'https://updates.example.test/files/assets/0123456789abcdef0123456789abcdef',
    }]);
    expect(manifest.runtimeVersion).toBe('1.2');
    expect(manifest.createdAt).toBe(createdAt);
    expect(manifest.extra.expoClient).toEqual(expoConfig);
    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('keeps the id for the same content and time, and changes it for a new time', () => {
    const first = buildManifest({ distDir: dist, platform: 'ios', expoConfig, baseUrl, createdAt });
    const again = buildManifest({ distDir: dist, platform: 'ios', expoConfig, baseUrl, createdAt });
    const later = buildManifest({ distDir: dist, platform: 'ios', expoConfig, baseUrl, createdAt: '2026-10-29T12:00:00.000Z' });
    expect(again.id).toBe(first.id);
    expect(later.id).not.toBe(first.id);
  });

  it('refuses a runtime version that could leave the update folder', () => {
    expect(() => buildManifest({ distDir: dist, platform: 'ios', expoConfig: { runtimeVersion: '../1.2' }, baseUrl, createdAt }))
      .toThrow(/runtimeVersion/);
  });
});

describe('build-updates CLI', () => {
  it('dates the update with the HEAD commit, so re-deploying a commit sends nothing new', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'pane-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' },
    });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'x');
    writeFileSync(path.join(repo, 'config.json'), JSON.stringify(expoConfig));

    const out = path.join(repo, 'site');
    execFileSync(process.execPath, [script, '--dist', dist, '--config', 'config.json', '--base-url', baseUrl, '--out', out], { cwd: repo });
    const manifest = JSON.parse(readFileSync(path.join(out, 'updates/1.2/ios/manifest.json'), 'utf8')) as UpdateManifest;
    expect(manifest.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });
});
