import { describe, it, expect } from 'vitest';
import { groupMissionControlTiles, compareMissionControlTiles, describeMissionControlTile } from './missionControlGrouping';
import type { MissionControlTileModel } from '../../../shared/types/missionControl';

function tile(overrides: Partial<MissionControlTileModel> & { panelId: string }): MissionControlTileModel {
  return {
    sessionId: `session-${overrides.panelId}`,
    sessionName: 'Session',
    projectId: 1,
    projectName: 'Alpha',
    worktreePath: '/repo/alpha',
    worktreeName: 'alpha',
    panelTitle: 'Terminal',
    agentType: 'claude',
    isPermanent: false,
    isLive: true,
    agentState: 'idle',
    snapshot: null,
    ...overrides,
  };
}

describe('describeMissionControlTile', () => {
  it('names each level when they differ', () => {
    expect(describeMissionControlTile({
      projectName: 'Super Forum',
      sessionName: 'security',
      panelTitle: 'Terminal',
    })).toBe('Super Forum / security / Terminal');
  });

  it('says a repeated name once — Pane Chat is project, session and panel', () => {
    expect(describeMissionControlTile({
      projectName: 'Pane Chat',
      sessionName: 'Pane Chat',
      panelTitle: 'Pane Chat',
    })).toBe('Pane Chat');
  });

  it('treats a difference in case as a repeat', () => {
    expect(describeMissionControlTile({
      projectName: 'Pane',
      sessionName: 'pane',
      panelTitle: 'Terminal',
    })).toBe('Pane / Terminal');
  });

  it('skips empty parts rather than leaving stray separators', () => {
    expect(describeMissionControlTile({
      projectName: '',
      sessionName: 'security',
      panelTitle: '  ',
    })).toBe('security');
  });
});

describe('compareMissionControlTiles', () => {
  it('puts blocked agents before working, and working before idle', () => {
    const sorted = [
      tile({ panelId: 'c', agentState: 'idle' }),
      tile({ panelId: 'a', agentState: 'blocked' }),
      tile({ panelId: 'd', agentState: 'unknown' }),
      tile({ panelId: 'b', agentState: 'working' }),
    ].sort(compareMissionControlTiles);

    expect(sorted.map(t => t.panelId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to project then session name within the same state', () => {
    const sorted = [
      tile({ panelId: '2', projectName: 'Beta', sessionName: 'x' }),
      tile({ panelId: '1', projectName: 'Alpha', sessionName: 'z' }),
      tile({ panelId: '3', projectName: 'Alpha', sessionName: 'a' }),
    ].sort(compareMissionControlTiles);

    expect(sorted.map(t => t.panelId)).toEqual(['3', '1', '2']);
  });
});

describe('groupMissionControlTiles', () => {
  it('returns no groups for no tiles', () => {
    expect(groupMissionControlTiles([], 'project')).toEqual([]);
    expect(groupMissionControlTiles([], 'none')).toEqual([]);
  });

  it('puts everything in one bucket when grouping is disabled', () => {
    const groups = groupMissionControlTiles([tile({ panelId: 'a' }), tile({ panelId: 'b' })], 'none');
    expect(groups).toHaveLength(1);
    expect(groups[0].tiles).toHaveLength(2);
  });

  it('groups by project and labels buckets with the project name', () => {
    const groups = groupMissionControlTiles([
      tile({ panelId: 'a', projectId: 1, projectName: 'Alpha' }),
      tile({ panelId: 'b', projectId: 2, projectName: 'Beta' }),
      tile({ panelId: 'c', projectId: 1, projectName: 'Alpha' }),
    ], 'project');

    expect(groups).toHaveLength(2);
    const alpha = groups.find(g => g.label === 'Alpha');
    expect(alpha?.tiles).toHaveLength(2);
  });

  it('keeps sessions without a project in their own bucket', () => {
    const groups = groupMissionControlTiles([
      tile({ panelId: 'a', projectId: null, projectName: 'Unknown project' }),
    ], 'project');

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('no-project');
  });

  it('orders groups by their most urgent member', () => {
    const groups = groupMissionControlTiles([
      tile({ panelId: 'a', projectId: 1, projectName: 'Alpha', agentState: 'idle' }),
      tile({ panelId: 'b', projectId: 2, projectName: 'Beta', agentState: 'blocked' }),
    ], 'project');

    expect(groups.map(g => g.label)).toEqual(['Beta', 'Alpha']);
  });

  it('groups by status with human-readable labels', () => {
    const groups = groupMissionControlTiles([
      tile({ panelId: 'a', agentState: 'blocked' }),
      tile({ panelId: 'b', agentState: 'working' }),
    ], 'status');

    expect(groups.map(g => g.label)).toEqual(['Needs input', 'Working']);
  });

  it('groups by agent type and buckets unknown agents together', () => {
    const groups = groupMissionControlTiles([
      tile({ panelId: 'a', agentType: 'claude' }),
      tile({ panelId: 'b', agentType: 'codex' }),
      tile({ panelId: 'c', agentType: null }),
    ], 'agent');

    expect(groups.map(g => g.label).sort()).toEqual(['Claude', 'Codex', 'Other agents']);
  });

  it('does not mutate the input array', () => {
    const tiles = [tile({ panelId: 'b', agentState: 'idle' }), tile({ panelId: 'a', agentState: 'blocked' })];
    const before = tiles.map(t => t.panelId);
    groupMissionControlTiles(tiles, 'project');
    expect(tiles.map(t => t.panelId)).toEqual(before);
  });
});
