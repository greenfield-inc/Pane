import path from 'path';
import { WebContentsView } from 'electron';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/** How long the scaler's page stays open after the last frame it scaled. */
const IDLE_CLOSE_MS = 30_000;
/** How long one frame may take before the caller sends it whole instead. */
const JOB_TIMEOUT_MS = 5_000;
/** JPEG quality for a scaled frame: sharp text at a fraction of the bytes. */
const JPEG_QUALITY = 0.8;

const answerSchema = boundary.object({ id: boundary.number, url: boundary.optional(boundary.nullable(boundary.string)), error: boundary.optional(boundary.string) });

/**
 * Scales device frames for remote viewers outside Pane's main process: an offscreen page (no
 * window, so nothing counts it as one of Pane's) decodes, resizes and encodes each frame with
 * Chromium's codecs, and the main thread only hands bytes over. It opens on the first frame and
 * closes after IDLE_CLOSE_MS without one.
 */
export class FrameScaler {
  private view?: Promise<WebContentsView | undefined>;
  private idle?: NodeJS.Timeout;
  private nextId = 0;
  private readonly waiting = new Map<number, (url: string | null | undefined) => void>();

  /**
   * `frame` (JPEG or PNG) as a JPEG data URL with its longest side at most `maxPx`; null when it
   * already fits; undefined when it could not be scaled here (no page, an error, too slow).
   */
  async scale(frame: Buffer, maxPx: number): Promise<string | null | undefined> {
    const view = await this.open();
    if (!view || view.webContents.isDestroyed()) return undefined;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    this.idle.unref();
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(undefined); }, JOB_TIMEOUT_MS);
      this.waiting.set(id, (url) => { clearTimeout(timer); resolve(url); });
      view.webContents.send('frame-scaler:scale', { id, bytes: frame, maxPx, quality: JPEG_QUALITY });
    });
  }

  close(): void {
    clearTimeout(this.idle);
    const view = this.view;
    this.view = undefined;
    for (const answer of this.waiting.values()) answer(undefined);
    this.waiting.clear();
    void view?.then(open => { if (open && !open.webContents.isDestroyed()) open.webContents.close(); });
  }

  private open(): Promise<WebContentsView | undefined> {
    this.view ??= (async () => {
      try {
        const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'frameScalerPreload.js') } });
        view.webContents.setFrameRate(1);
        view.webContents.ipc.on('frame-scaler:scaled', (_event, raw: JsonValue) => {
          const answer = decodeOptionalBoundary(raw, answerSchema);
          if (!answer) return;
          this.waiting.get(answer.id)?.(answer.error ? undefined : answer.url ?? null);
          this.waiting.delete(answer.id);
        });
        await view.webContents.loadURL('about:blank');
        return view;
      } catch {
        return undefined;
      }
    })();
    return this.view;
  }
}
