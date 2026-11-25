import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { usePanelStore } from '../stores/panelStore';
import { SessionActivityCount, SessionActivityDot, SessionActivityIcon, SessionWorkingSpinner } from './SessionActivity';

// SAFETY: the components read only id and internalSessionId.
const session = { id: 's1', internalSessionId: 'owner' } as OrchestrationSessionRecord;
const text = (html: string) => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  usePanelStore.setState({ agentStatus: {}, agentStatusSession: {}, unviewedCompletedActivity: {} });
});

describe('Session activity icon (Option 1, D-363)', () => {
  it('is an empty ring when the host says nothing, as for an old or offline host', () => {
    const html = renderToStaticMarkup(<SessionActivityDot session={session} paneIds={['p1']} />);
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('aria-label="Session idle"');
    expect(html).not.toContain('animate-spin');
  });

  it('spins when the host says the Session is working', () => {
    const html = renderToStaticMarkup(<SessionActivityIcon state="working" />);
    expect(html).toContain('data-state="working"');
    expect(html).toContain('animate-spin');
  });

  it('never shows red, even with an agent blocked in the Session', () => {
    usePanelStore.setState({ agentStatus: { t1: 'blocked' }, agentStatusSession: { t1: 'owner' } });
    const html = renderToStaticMarkup(<SessionActivityDot session={session} paneIds={[]} />);
    expect(html).toContain('data-state="idle"');
    expect(html).not.toContain('status-error');
  });

  it('keeps one fixed 12 px box in both states, so swapping moves nothing', () => {
    const box = (html: string) => html.match(/^<span class="([^"]+)"/)?.[1];
    const idle = renderToStaticMarkup(<SessionActivityIcon state="idle" />);
    const working = renderToStaticMarkup(<SessionActivityIcon state="working" />);
    expect(box(idle)).toBe(box(working));
    expect(box(idle)).toContain('w-3 h-3');
  });
});

describe('Session row spinner (T-63)', () => {
  it('shows nothing while the Session is idle', () => {
    expect(renderToStaticMarkup(<SessionWorkingSpinner session={session} />)).toBe('');
  });

  it('spins in grey, never in a status colour, in the same 12 px box', () => {
    const html = renderToStaticMarkup(<SessionActivityIcon state="working" neutral />);
    expect(html).toContain('animate-spin');
    expect(html).toContain('border-t-text-secondary');
    expect(html).not.toContain('status-');
    expect(html).toContain('w-3 h-3');
  });
});

describe('Session activity label', () => {
  it('says how many Panes the host counts as working', () => {
    expect(text(renderToStaticMarkup(<SessionActivityCount blocked={0} working={2} panes={3} />))).toBe('2 working');
  });

  it('puts "need input" first', () => {
    expect(text(renderToStaticMarkup(<SessionActivityCount blocked={1} working={2} panes={3} />))).toBe('1 needs input');
  });

  it('shows the plain Pane count when nothing is working, and nothing with no Panes', () => {
    expect(text(renderToStaticMarkup(<SessionActivityCount blocked={0} working={0} panes={2} />))).toBe('2');
    expect(renderToStaticMarkup(<SessionActivityCount blocked={0} working={0} panes={0} />)).toBe('');
  });
});
