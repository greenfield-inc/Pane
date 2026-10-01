import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Written by the Session bootstrap (serve guard) on every Runpane Cloud Session: `{"transport","port"}`.
 * On a new Session the bootstrap writes it AFTER the daemon's first start (install-pane runs before the
 * serve guard), so daemon code must not decide "not a Session" once at startup.
 */
export const CLOUD_SERVE_RECORD = '/etc/rp-cloud/serve.json';

const MARKER_POLL_MS = 2_000;
/** The bootstrap writes the marker about a minute after the daemon's first start; past this, it is not a Session. */
const MARKER_WAIT_MS = 15 * 60_000;

/**
 * The Session bootstrap's state directory (rp-bootstrap.sh `RP_STATE`), created before it installs Pane.
 * Without it no bootstrap is running, so no marker is coming.
 */
const CLOUD_BOOTSTRAP_STATE_DIR = path.join(os.homedir(), '.runpane-cloud');

interface WhenCloudSessionOptions {
  path?: string;
  bootstrapStateDir?: string;
  pollMs?: number;
  waitMs?: number;
}

/**
 * Runs `onReady` once this daemon is in a Runpane Cloud Session: now when the marker exists, else as soon
 * as the bootstrap writes it (checked every couple of seconds for up to 15 minutes). It only waits on Linux
 * with a Session bootstrap in progress (its state directory exists), so desktop and self-hosted daemons
 * never start the timer; the timer never keeps the process alive. Returns a function that stops waiting.
 */
export function whenCloudSession(onReady: () => void, options: WhenCloudSessionOptions = {}): () => void {
  const marker = options.path ?? CLOUD_SERVE_RECORD;
  if (fs.existsSync(marker)) {
    onReady();
    return () => undefined;
  }
  if (process.platform !== 'linux' || !fs.existsSync(options.bootstrapStateDir ?? CLOUD_BOOTSTRAP_STATE_DIR)) return () => undefined;
  const giveUpAt = Date.now() + (options.waitMs ?? MARKER_WAIT_MS);
  const timer = setInterval(() => {
    if (Date.now() > giveUpAt) clearInterval(timer);
    if (!fs.existsSync(marker)) return;
    clearInterval(timer);
    onReady();
  }, options.pollMs ?? MARKER_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
