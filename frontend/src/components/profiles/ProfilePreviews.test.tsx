import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProfileSubagentNode } from '../../../../shared/types/profileEditor';
import { HtmlPage } from './ProfilePreviews';

const planner: ProfileSubagentNode = {
  kind: 'subagent',
  id: 'lead/planner',
  alias: 'planner',
  agent: 'greenfield/planner',
  label: 'Planner',
  mode: 'launch',
  harness: 'claude',
  command: 'agent-farm run greenfield/planner --agent-only',
  profile: 'greenfield/planner',
  children: [],
};

describe('HtmlPage', () => {
  beforeEach(() => {
    // The page's base style reads Pane's theme tokens from the window; these tests run without one.
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows a linked launch agent’s mode and run command above its custom cover (F-8)', () => {
    const markup = renderToStaticMarkup(<HtmlPage html="<h1>Planner</h1>" title="greenfield/covers/planner.html" subagent={planner} />);
    expect(markup).toContain('data-testid="profiles-cover-link"');
    expect(markup).toContain('planner · greenfield/planner · runs as its own launch, in a tab or headless');
    expect(markup).toMatch(/data-testid="profiles-cover-command"[^>]*>agent-farm run greenfield\/planner --agent-only</);
    expect(markup.indexOf('profiles-cover-command')).toBeLessThan(markup.indexOf('profiles-html-preview'));
  });

  it('shows a linked agent’s unresolved link above its custom cover', () => {
    const markup = renderToStaticMarkup(<HtmlPage html="<h1>Planner</h1>" title="cover" subagent={{ ...planner, command: undefined, error: 'no agent named planner' }} />);
    expect(markup).toContain('data-testid="profiles-cover-error"');
    expect(markup).toContain('no agent named planner');
  });

  it('shows only the page for an HTML file that is not a linked agent’s cover', () => {
    const markup = renderToStaticMarkup(<HtmlPage html="<h1>Lead</h1>" title="cover" />);
    expect(markup).toContain('data-testid="profiles-html-preview"');
    expect(markup).not.toContain('profiles-cover-link');
    expect(markup).not.toContain('profiles-cover-command');
  });
});
