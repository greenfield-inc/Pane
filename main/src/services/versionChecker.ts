import { app } from 'electron';
import { ConfigManager } from './configManager';
import { Logger } from '../utils/logger';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

export interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets?: GitHubReleaseAsset[];
}

export class VersionChecker {
  private logger: Logger;
  private configManager: ConfigManager;
  private readonly checkIntervalMs = 24 * 60 * 60 * 1000; // 24 hours
  private checkTimeout?: NodeJS.Timeout;

  constructor(configManager: ConfigManager, logger: Logger) {
    this.configManager = configManager;
    this.logger = logger;
  }

  public async checkForUpdates(): Promise<VersionInfo> {
    try {
      const currentVersion = app.getVersion();

      // Fetch latest release from GitHub API
      const response = await fetch('https://api.github.com/repos/greenfield-inc/Pane/releases/latest');
      
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
      }

      const release = decodeBoundary(await response.json(), boundary.object({
        tag_name: boundary.string,
        name: boundary.nullable(boundary.string),
        body: boundary.nullable(boundary.string),
        html_url: boundary.string,
        published_at: boundary.string,
        prerelease: boundary.boolean,
        draft: boundary.boolean,
        assets: boundary.optional(boundary.array(boundary.object({
          name: boundary.string,
          browser_download_url: boundary.string,
        }))),
      }));
      
      // Skip pre-releases and drafts
      if (release.prerelease || release.draft) {
        return {
          current: currentVersion,
          latest: currentVersion,
          hasUpdate: false
        };
      }

      const latestVersion = this.normalizeVersion(release.tag_name);
      const hasUpdate = this.isNewerVersion(latestVersion, currentVersion);

      return {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate,
        releaseUrl: release.html_url,
        downloadUrl: this.findMacDmgDownloadUrl(release),
        releaseNotes: release.body ?? undefined,
        publishedAt: release.published_at
      };
    } catch (error) {
      this.logger.error(`[Version Checker] Failed to check for updates:`, error instanceof Error ? error : new Error(String(error)));
      
      // Return current version info without update on error
      return {
        current: app.getVersion(),
        latest: app.getVersion(),
        hasUpdate: false
      };
    }
  }

  public async checkOnStartup(): Promise<void> {
    try {
      const versionInfo = await this.checkForUpdates();
      
      if (versionInfo.hasUpdate) {
        this.logger.info(`[Version Checker] Update available on startup: ${versionInfo.latest}`);
        // Emit event for UI notification
        // SAFETY: Pane registers this application-owned process event and its VersionInfo payload in events.ts.
        (process as NodeJS.Process & { emit(event: 'version-update-available', data: VersionInfo): boolean })
          .emit('version-update-available', versionInfo);
      }
    } catch (error) {
      this.logger.error(`[Version Checker] Startup check failed:`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  public startPeriodicCheck(): void {
    // Check if auto-updates are enabled in config
    const config = this.configManager.getConfig();
    if (config.autoCheckUpdates === false) {
      return;
    }
    
    // Set up periodic checks (don't check immediately since we do that on startup)
    this.checkTimeout = setInterval(() => {
      this.performCheck();
    }, this.checkIntervalMs);
  }

  public stopPeriodicCheck(): void {
    if (this.checkTimeout) {
      clearInterval(this.checkTimeout);
      this.checkTimeout = undefined;
    }
  }

  private async performCheck(): Promise<void> {
    try {
      // Check if auto-updates are still enabled (settings might have changed)
      const config = this.configManager.getConfig();
      if (config.autoCheckUpdates === false) {
        this.stopPeriodicCheck();
        return;
      }

      const versionInfo = await this.checkForUpdates();
      
      if (versionInfo.hasUpdate) {
        this.logger.info(`[Version Checker] Update available: ${versionInfo.latest}`);
        // Emit event for UI notification
        // SAFETY: Pane registers this application-owned process event and its VersionInfo payload in events.ts.
        (process as NodeJS.Process & { emit(event: 'version-update-available', data: VersionInfo): boolean })
          .emit('version-update-available', versionInfo);
      }
    } catch (error) {
      this.logger.error(`[Version Checker] Periodic check failed:`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private normalizeVersion(version: string): string {
    // Remove 'v' prefix and any pre-release suffix (e.g., -canary.abc123)
    return version.replace(/^v/, '').replace(/-.*$/, '');
  }

  private findMacDmgDownloadUrl(release: GitHubRelease): string | undefined {
    return release.assets?.find(asset => {
      const name = asset.name.toLowerCase();
      return name.endsWith('.dmg') && !name.includes('blockmap');
    })?.browser_download_url;
  }

  private isNewerVersion(latest: string, current: string): boolean {
    try {
      const normalizedLatest = this.normalizeVersion(latest);
      const normalizedCurrent = this.normalizeVersion(current);

      const parseVersion = (v: string) => v.split('.').map(Number);

      const latestParts = parseVersion(normalizedLatest);
      const currentParts = parseVersion(normalizedCurrent);

      // Pad arrays to same length
      const maxLength = Math.max(latestParts.length, currentParts.length);
      while (latestParts.length < maxLength) latestParts.push(0);
      while (currentParts.length < maxLength) currentParts.push(0);

      // Compare version parts
      for (let i = 0; i < maxLength; i++) {
        if (latestParts[i] > currentParts[i]) {
          return true;
        } else if (latestParts[i] < currentParts[i]) {
          return false;
        }
      }

      // Same base version but current has pre-release suffix — latest is newer
      if (current.includes('-') && !latest.includes('-')) {
        return true;
      }

      return false; // Versions are equal
    } catch (error) {
      this.logger.error(`[Version Checker] Failed to compare versions ${latest} vs ${current}:`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
}
