import { EventEmitter } from 'events';
import type { ConfigManager } from './configManager';
import { app, BrowserWindow, net } from 'electron';
import * as crypto from 'crypto';
import * as os from 'os';
import { failureDetails, FailureLimiter } from '../utils/failureTelemetry';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

type AppExceptionSource = 'main-uncaught' | 'renderer-error' | 'renderer-rejection' | 'react-boundary' | 'renderer-crash' | 'renderer-oom' | 'shutdown';
type AnalyticsConfig = Pick<ConfigManager, 'isAnalyticsEnabled' | 'getAnalyticsSettings' | 'isVerbose'>;

export class AnalyticsManager extends EventEmitter {
  private configManager: AnalyticsConfig;
  private mainWindow: BrowserWindow | null = null;
  private exceptionLimiter = new FailureLimiter();
  private errorRequests = 0;

  constructor(configManager: AnalyticsConfig, private runtime = {
    fetch: (url: string, options: RequestInit) => net.fetch(url, options),
    getVersion: () => app.getVersion(),
    getAppPath: () => app.getAppPath(),
  }) {
    super();
    this.configManager = configManager;
  }

  /**
   * Set the main window reference for IPC forwarding
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Track an event by forwarding to renderer via IPC
   */
  track(eventName: string, properties?: Record<string, string | number | boolean | string[] | undefined>): void {
    if (!this.isEnabled()) return;
    if (eventName === 'runpane_local_control_failed') {
      // Avoid renderer SDK enrichment with URLs and account properties.
      this.sendErrorEvent(eventName, {
        action: properties?.action,
        status: properties?.status,
        command_ok: properties?.command_ok,
        failure_kind: properties?.failure_kind,
        error_type: properties?.error_type,
        error_code: properties?.error_code,
        failure_category: properties?.failure_category,
      });
      return;
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.webContents) return;

    const enhanced = {
      ...properties,
      app_version: this.runtime.getVersion(),
      platform: os.platform(),
      electron_version: process.versions.electron,
    };

    const cleaned = Object.fromEntries(
      Object.entries(enhanced).filter(([_, v]) => v !== undefined)
    );

    try {
      this.mainWindow.webContents.send('analytics:main-event', { eventName, properties: cleaned });
    } catch {
      // Renderer may be crashed/reloading — swallow so callers aren't affected
      return;
    }

    if (this.configManager.isVerbose()) {
      console.log(`[Analytics] Forwarded to renderer: ${eventName}`, cleaned);
    }
  }

  /**
   * Send app exceptions independently of the renderer. The manual PostHog
   * exception schema avoids automatic URL, source-context and person properties.
   * Never await this at a crash boundary: delivery during process exit is best effort.
   */
  captureException(cause: unknown, source: AppExceptionSource): void {
    try {
      if (!this.isEnabled()) return;
      const details = failureDetails(cause);
      const frames = this.appStackFrames(cause);
      const key = JSON.stringify([source, details.error_type, details.error_code, frames]);
      if (!this.exceptionLimiter.allow(key)) return;

      this.sendErrorEvent('$exception', {
        source,
        ...details,
        $exception_level: 'error',
        $exception_list: [{
          type: details.error_type,
          value: `Pane ${source} (${details.error_code})`,
          mechanism: { handled: source === 'react-boundary' || source === 'shutdown', synthetic: false },
          stacktrace: { type: 'raw', frames },
        }],
      });
    } catch {
      // Telemetry must not change app error handling, including synchronous failures.
    }
  }

  private sendErrorEvent(event: '$exception' | 'runpane_local_control_failed', properties: Record<string, JsonValue | undefined>): void {
    try {
      if (!this.isEnabled() || this.errorRequests >= 4) return;
      const settings = this.configManager.getAnalyticsSettings();
      const distinctId = settings.installId && /^install_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settings.installId)
        ? `install:${settings.installId}` : undefined;
      if (!distinctId) return; // Don't create identity or write config on an error path.
      const token = settings.posthogApiKey || 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1';
      const host = settings.posthogHost || 'https://runpane.com/api/c';
      const body = JSON.stringify({
        api_key: token,
        event,
        properties: {
          ...properties,
          distinct_id: distinctId,
          $process_person_profile: false,
          app_version: this.runtime.getVersion(),
          platform: os.platform(),
          electron_version: process.versions.electron,
        },
      });
      this.errorRequests++;
      let request: Promise<Response>;
      try {
        // Start immediately: a fatal monitor callback may never reach another
        // microtask. Completion is still best effort when the process exits.
        request = this.runtime.fetch(`${host.replace(/\/$/, '')}/capture/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        this.errorRequests--;
        return;
      }
      void request.catch(() => {}).finally(() => { this.errorRequests--; });
    } catch {
      // Do not recursively report transport errors or interfere with callers.
    }
  }

  private appStackFrames(cause: unknown) {
    const frames: { platform: string; lang: string; function: string; filename: string; lineno: number; colno: number; in_app: boolean }[] = [];
    if (!(cause instanceof Error) || !cause.stack) return frames;
    const root = this.runtime.getAppPath().replace(/\\/g, '/').replace(/\/$/, '') + '/';
    for (const line of cause.stack.slice(0, 16_384).split('\n').slice(1, 41)) {
      const location = line.match(/^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/);
      if (!location) continue;
      let filename: string;
      try { filename = decodeURIComponent(location[1]).replace(/^file:\/\//, '').replace(/\\/g, '/'); } catch { continue; }
      // file:///C:/... has an extra leading slash compared with getAppPath().
      if (location[1].startsWith('file://')) filename = filename.replace(/^\/([A-Za-z]:\/)/, '$1');
      if (!filename.startsWith(root)) continue;
      const relative = filename.slice(root.length);
      // Only packaged app JS. No repo files, external dependencies, function
      // names, source context, query strings or development-server URLs.
      if (!/^(?:main\/dist\/(?:main\/src|shared)\/[A-Za-z0-9_/-]+|frontend\/dist\/assets\/[A-Za-z0-9_-]+)\.js$/.test(relative) || relative.includes('..') || relative.length > 200) continue;
      if (location[2].length > 7 || location[3].length > 7) continue;
      frames.push({ platform: 'custom', lang: 'javascript', function: '[app]', filename: relative, lineno: Number(location[2]), colno: Number(location[3]), in_app: true });
      if (frames.length >= 10) break;
    }
    return frames.reverse(); // PostHog expects the most recent call last.
  }

  /**
   * Helper to hash session IDs for privacy
   */
  hashSessionId(sessionId: string): string {
    return crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 16);
  }

  /**
   * Categorize numeric values for privacy
   */
  categorizeNumber(value: number, thresholds: number[]): string {
    for (let i = 0; i < thresholds.length; i++) {
      if (value <= thresholds[i]) {
        return i === 0 ? `0-${thresholds[i]}` : `${thresholds[i - 1] + 1}-${thresholds[i]}`;
      }
    }
    return `${thresholds[thresholds.length - 1] + 1}+`;
  }

  /**
   * Categorize duration for privacy
   */
  categorizeDuration(seconds: number): string {
    if (seconds < 10) return '0-10s';
    if (seconds < 30) return '10-30s';
    if (seconds < 60) return '30-60s';
    if (seconds < 300) return '1-5m';
    if (seconds < 600) return '5-10m';
    if (seconds < 1800) return '10-30m';
    if (seconds < 3600) return '30-60m';
    return '60m+';
  }

  /**
   * Categorize prompt length for privacy
   */
  categorizePromptLength(length: number): string {
    if (length < 50) return 'short';
    if (length < 200) return 'medium';
    if (length < 500) return 'long';
    return 'very_long';
  }

  /**
   * Check if analytics is enabled
   */
  isEnabled(): boolean {
    return this.configManager.isAnalyticsEnabled();
  }
}
