import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionPort, SessionPortsSnapshot } from '../../../../shared/types/sessionPorts';
import { SessionPortsChips, SessionPortsLoadError, portProblem, suggestedPortLabel } from './SessionPortsChips';

const noop = async () => {};
const at = '2026-09-30T23:00:00Z';
const port = (name: string, number: number, extra: Partial<SessionPort> = {}): SessionPort => ({
  name, port: number, httpsPort: number, url: `https://rp-a.tail.ts.net:${number}/`, scheme: 'https', path: '/',
  source: 'user', createdAt: at, status: 'serving', ...extra,
});
const render = (snapshot: Omit<SessionPortsSnapshot, 'available'> & { available?: boolean }, variant: 'row' | 'inline' = 'row') => renderToStaticMarkup(
  <SessionPortsChips snapshot={{ available: true, ...snapshot }} onOpenUrl={() => {}} onPublish={noop} onClose={noop} variant={variant} />,
);

describe('SessionPortsChips', () => {
  it('renders nothing when the Session has no ports and no suggestions', () => {
    expect(render({ ports: [], suggested: [] })).toBe('');
  });

  it('renders nothing off a cloud Session (available: false)', () => {
    expect(render({ available: false, ports: [], suggested: [{ port: 3000, address: '0.0.0.0', detectedAt: at }] })).toBe('');
  });

  it('shows each published port as name and HTTPS port with open, copy and close, and flags an unreachable one', () => {
    const markup = render({
      ports: [port('site', 8787, { source: 'manifest', reachable: false }), port('pages', 8788)],
      suggested: [],
    });
    expect(markup).toContain('aria-label="Session ports"');
    expect(markup).toContain('aria-label="Open site (https://rp-a.tail.ts.net:8787/)"');
    expect(markup).toContain('aria-label="Copy site URL"');
    expect(markup).toContain('aria-label="Close pages"');
    expect(markup.match(/data-testid="session-port-chip"/g)).toHaveLength(2);
    expect(markup.match(/aria-label="Not answering on 127.0.0.1:8787"/g)).toHaveLength(1);
    expect(markup).not.toContain('Open on tailnet');
  });

  it('shows suggested listeners dimmed with Open on tailnet', () => {
    const markup = render({ ports: [], suggested: [{ port: 5173, process: 'vite', address: '127.0.0.1', detectedAt: at }] }, 'inline');
    expect(markup).toContain('data-testid="session-port-suggestion"');
    expect(markup).toContain('border-dashed');
    expect(markup).toContain('Open on tailnet');
    expect(markup).toContain('title="Listening on 127.0.0.1:5173"');
    // inline sits in an existing header: no strip border of its own
    expect(markup).not.toContain('border-b border-border-primary');
  });

  it('marks an http fallback port and explains serve problems', () => {
    const httpPort = port('api', 3000, { url: 'http://rp-a.tail.ts.net:3000/', scheme: 'http' });
    expect(render({ ports: [httpPort], suggested: [] })).toContain('>http</span>');
    expect(portProblem({ ...httpPort, status: 'serving' })).toBeNull();
    expect(portProblem({ ...httpPort, status: 'missing' })).toBe('Not being served (the daemon will restore it)');
    expect(portProblem({ ...httpPort, status: 'error', detail: 'serve: permission denied' })).toBe('serve: permission denied');
  });

  it('labels a suggestion by port and process', () => {
    expect(suggestedPortLabel({ port: 3000, address: '0.0.0.0', detectedAt: at })).toBe(':3000');
    expect(suggestedPortLabel({ port: 5173, address: '127.0.0.1', process: 'vite', detectedAt: at })).toBe(':5173 vite');
  });

  it('shows why the first read failed with a Retry button', () => {
    const markup = renderToStaticMarkup(<SessionPortsLoadError message="tailscale: not running" onRetry={() => {}} variant="inline" />);
    expect(markup).toContain('aria-label="Session ports"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Couldn&#x27;t load ports: tailscale: not running');
    expect(markup).toMatch(/<button[^>]*>.*Retry<\/button>/);
  });
});
