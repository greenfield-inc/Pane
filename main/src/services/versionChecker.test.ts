import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import type { Logger } from '../utils/logger';
import { VersionChecker } from './versionChecker';

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Each test supplies every dependency method reached by its scenario.
  return implementation as Contract;
}

describe('VersionChecker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts GitHub releases with nullable name and body fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tag_name: 'v2.4.62',
      name: null,
      body: null,
      html_url: 'https://github.com/greenfield-inc/Pane/releases/tag/v2.4.62',
      published_at: '2026-08-18T00:00:00Z',
      prerelease: false,
      draft: false,
      assets: [],
    }), { status: 200 })));
    const logger = partialMock<Logger>({ error: vi.fn() });
    const checker = new VersionChecker(partialMock<ConfigManager>({}), logger);

    const result = await checker.checkForUpdates();

    expect(result.latest).toBe('2.4.62');
    expect(result.hasUpdate).toBe(true);
    expect(result.releaseNotes).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('drops the GitHub download section and HTML comments from release notes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tag_name: 'v2.4.227',
      name: 'v2.4.227',
      body: "## What's Changed\n<!-- Release notes generated using configuration in .github/release.yml -->\n- Relay links recover in seconds\n\n**Full Changelog**: https://github.com/greenfield-inc/Pane/compare/v2.4.226...v2.4.227\n\n<!-- pane-download-links -->\n## Download\n\n- macOS (Apple Silicon): [Pane-2.4.227-macOS-arm64.dmg](https://runpane.com/api/download)\n",
      html_url: 'https://github.com/greenfield-inc/Pane/releases/tag/v2.4.227',
      published_at: '2026-11-14T00:00:00Z',
      prerelease: false,
      draft: false,
      assets: [],
    }), { status: 200 })));
    const checker = new VersionChecker(partialMock<ConfigManager>({}), partialMock<Logger>({ error: vi.fn() }));

    const result = await checker.checkForUpdates();

    expect(result.releaseNotes).toBe("## What's Changed\n\n- Relay links recover in seconds\n\n**Full Changelog**: https://github.com/greenfield-inc/Pane/compare/v2.4.226...v2.4.227");
  });
});
