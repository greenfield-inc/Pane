import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { SessionProfileMenuItems } from './SessionProfileMenu';

const noop = () => undefined;
const session = (fields: Partial<OrchestrationSessionRecord>): OrchestrationSessionRecord => ({
  id: 's1', name: 'S', agent: 'claude', internalSessionId: 'own', panelIds: { claude: 'c', codex: 'x', cursor: 'u', opencode: 'o', pi: 'p' },
  goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [], activity: [],
  revision: 1, createdAt: '', updatedAt: '', ...fields,
});
const reloadItem = (record: OrchestrationSessionRecord) => {
  const html = renderToStaticMarkup(<SessionProfileMenuItems session={record} onSwitch={noop} onReload={noop} onClose={noop} />);
  return html.slice(html.indexOf('data-testid="session-reload-profile"') - 200, html.indexOf('Reload profile') + 200);
};

describe('Reload profile in a Session\'s menu', () => {
  // Review F-1 (D-9): a Session whose lead runs in a terminal has a snapshot but no profile, and Reload takes a new snapshot.
  it('is available for a Session with a snapshot and no profile, and marked when it changed', () => {
    const item = reloadItem(session({ agentFarmSnapshot: '.agent-farm/snapshots/d1', agentProfileChanged: true }));
    expect(item).toContain('aria-disabled="false"');
    expect(item).not.toContain('no profile');
    expect(item).toContain('changed');
  });

  it('stays unavailable for a Session with neither, and says why', () => {
    const item = reloadItem(session({}));
    expect(item).toContain('aria-disabled="true"');
    expect(item).toContain('no profile');
  });
});
