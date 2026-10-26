import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionChecklist } from './ConnectionChecklist';
import type { RemoteConnectionCheck } from '../../../shared/types/remoteDaemon';

const failedCheck: RemoteConnectionCheck = {
  id: 3,
  profileId: 'devbox',
  hostLabel: 'devbox',
  route: 'Tailscale',
  address: '100.84.12.7',
  outcome: 'failed',
  rows: [
    { stage: 'reachable', status: 'passed', label: 'Host reachable', metric: '38 ms' },
    {
      stage: 'running',
      status: 'failed',
      label: 'Pane daemon not running on devbox',
      detail: 'Nothing answered on port 42137.',
      fix: { kind: 'run-on-host', label: 'Start it', command: 'npx --yes runpane@latest daemon repair --yes' },
    },
    { stage: 'signed-in', status: 'running', label: 'Signed in' },
    { stage: 'version', status: 'waiting', label: 'Versions match' },
  ],
  // No zone suffix: parsed as local time, so it formats the same in any time zone.
  lastConnectedAt: '2026-10-26T09:12:00',
  hostVersion: '2.4.200',
};

const text = (html: string) => html.replace(/<[^>]+>/g, '');
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1]);

function render(check: RemoteConnectionCheck) {
  const markup = renderToStaticMarkup(
    <ConnectionChecklist check={check} onOpenSettings={() => undefined} onUpdatePane={() => undefined} />,
  );
  const rows = [...markup.matchAll(/<li[\s\S]*?<\/li>/g)].map((match) => match[0]);
  const row = (label: string) => {
    const match = rows.find((item) => text(item).includes(label));
    if (!match) throw new Error(`No row for ${label}`);
    return match;
  };
  /** The class list of a row's status badge, the first span in the row. */
  const badge = (label: string) => /<span class="([^"]*)"/.exec(row(label))?.[1] ?? '';
  return { markup, row, badge };
}

describe('ConnectionChecklist', () => {
  it('shows the host, route and each row in its state', () => {
    const { markup, row } = render(failedCheck);

    expect(markup).toContain('>Connecting to devbox</h2>');
    expect(text(markup)).toContain('over Tailscale · 100.84.12.7');

    expect(row('Host reachable')).toContain('data-status="passed"');
    expect(text(row('Host reachable'))).toBe('Host reachable38 ms');

    const failed = row('Pane daemon not running on devbox');
    expect(failed).toContain('<p class="font-semibold">Pane daemon not running on devbox</p>');
    expect(text(failed)).toContain('Nothing answered on port 42137.');
    expect(buttons(failed)).toEqual(['Start it']);

    expect(row('Versions match')).toContain('opacity-60');
    expect(text(row('Versions match'))).toBe('Versions matchwaiting');
  });

  it('holds the running spinner in the same 16px box as every other badge', () => {
    const { badge } = render(failedCheck);

    expect(badge('Signed in')).toContain('animate-spin');
    for (const label of ['Host reachable', 'Pane daemon not running on devbox', 'Signed in', 'Versions match']) {
      expect(badge(label)).toContain('h-4 w-4');
    }
  });

  it('offers the fix and Continue to workspace beside a version warning', () => {
    const { markup, row } = render({
      ...failedCheck,
      outcome: 'warning',
      rows: [
        { stage: 'reachable', status: 'passed', label: 'Host reachable', metric: '38 ms' },
        {
          stage: 'version',
          status: 'warning',
          label: 'devbox runs an older Pane (2.4.200)',
          fix: { kind: 'run-on-host', label: 'Update it' },
        },
        { stage: 'workspace', status: 'passed', label: 'Workspace loaded' },
      ],
    });

    const warning = row('devbox runs an older Pane (2.4.200)');
    expect(warning).toContain('data-status="warning"');
    expect(buttons(warning)).toEqual(['Update it', 'Continue to workspace']);
    expect(buttons(markup).slice(-3)).toEqual(['Retry', 'Use this computer', 'Connection settings']);
  });

  it('builds the footnote only from what the app knows', () => {
    const footnote = (check: Partial<RemoteConnectionCheck>) =>
      /<p class="mt-2\.5[^"]*">(.*?)<\/p>/.exec(render({ ...failedCheck, ...check }).markup)?.[1] ?? null;

    expect(footnote({})).toBe('Last connected at 09:12, running Pane 2.4.200.');
    expect(footnote({ hostVersion: null })).toBe('Last connected at 09:12.');
    expect(footnote({ lastConnectedAt: null })).toBe('devbox runs Pane 2.4.200.');
    expect(footnote({ lastConnectedAt: null, hostVersion: null })).toBeNull();
  });
});
