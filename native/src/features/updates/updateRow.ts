// What Settings › App says about the running JavaScript: built in, which
// over-the-air update, or a restart that applies a downloaded one.
export type UpdateRowInput = {
  version: string;
  /** False in debug and dev-client builds, where Metro serves the JavaScript. */
  updatesEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId?: string;
  createdAt?: Date;
  isChecking: boolean;
  isDownloading: boolean;
  isUpdatePending: boolean;
  /** The last check or download failed. */
  failed: boolean;
};

export type UpdateRow =
  | { kind: 'version'; title: string; subtitle?: string }
  | { kind: 'checking'; title: string }
  | { kind: 'restart'; title: string; subtitle: string };

export function describeUpdateRow(input: UpdateRowInput): UpdateRow {
  const version = `Version ${input.version}`;
  if (!input.updatesEnabled) return { kind: 'version', title: `${version} · Development build` };
  const running = input.isEmbeddedLaunch || !input.updateId
    ? `${version} · Built-in`
    : `${version} · Update ${input.updateId.slice(0, 7)}${input.createdAt ? ` · ${formatDay(input.createdAt)}` : ''}`;
  if (input.isUpdatePending) return { kind: 'restart', title: 'Restart to update', subtitle: running };
  if (input.isChecking || input.isDownloading) return { kind: 'checking', title: 'Checking for updates…' };
  return input.failed
    ? { kind: 'version', title: running, subtitle: "Couldn't reach the update server. Tap to try again." }
    : { kind: 'version', title: running };
}

const formatDay = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
