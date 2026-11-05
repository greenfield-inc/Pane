import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TerminalPausedMark, ToolPanel } from '../../../../shared/types/panels';
import { PanelContainer } from './PanelContainer';

const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60_000).toISOString();

function terminalTab(paused?: TerminalPausedMark): ToolPanel {
  return {
    id: 'panel-1',
    sessionId: 'pane-1',
    type: 'terminal',
    title: 'pnpm dev',
    state: { isActive: true, customState: { paused } },
    metadata: { createdAt: '2026-11-01T00:00:00Z', lastActiveAt: '2026-11-01T00:00:00Z', position: 0 },
  };
}

describe('PanelContainer for a terminal tab', () => {
  it('shows a paused tab under the paused banner with Resume, without loading its terminal', () => {
    const markup = renderToStaticMarkup(<PanelContainer panel={terminalTab({ at: twoDaysAgo(), by: 'manual' })} isActive />);
    expect(markup).toContain('Paused 2 days ago');
    expect(markup).toContain('last screen');
    expect(markup).toContain('Resume');
    expect(markup).not.toContain('Loading');
  });

  it('loads the live terminal for a tab that is not paused', () => {
    const markup = renderToStaticMarkup(<PanelContainer panel={terminalTab()} isActive />);
    expect(markup).not.toContain('Paused');
  });
});
