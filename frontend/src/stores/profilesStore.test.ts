import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilesOverview } from '../../../shared/types/profileEditor';
import { displayedFile, fileKey, useProfilesStore } from './profilesStore';

/** greenfield/orchestrator with no cover file, so the tab generates its cover; one subagent with no profile. */
const overview: ProfilesOverview = {
  machine: 'this-mac',
  plugins: [{
    name: 'greenfield',
    version: '0.1.0',
    bundled: true,
    edited: false,
    files: ['agents/orchestrator.md', 'agents/helper.md', 'plugin.yaml'],
    profiles: [{
      name: 'orchestrator',
      ref: 'greenfield/orchestrator',
      entry: 'agents/orchestrator.md',
      harness: 'claude',
      listed: true,
      uses: ['agents/orchestrator.md'],
      tree: [{ kind: 'subagent', id: 'helper', alias: 'helper', agent: 'helper', label: 'Helper', harness: 'claude', identity: 'agents/helper.md', children: [] }],
    }],
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  useProfilesStore.setState({ overview: null, place: { level: 'list' }, saved: {}, drafts: {}, onDisk: {} });
});

describe('displayedFile (review F-4)', () => {
  it('reads a generated cover from its identity file, the profile\'s or the subagent\'s', () => {
    expect(displayedFile(overview, 'greenfield', 'orchestrator', 'cover:')).toBe('agents/orchestrator.md');
    expect(displayedFile(overview, 'greenfield', 'orchestrator', 'cover:helper')).toBe('agents/helper.md');
    expect(displayedFile(overview, 'greenfield', 'orchestrator', 'plugin.yaml')).toBe('plugin.yaml');
    expect(displayedFile(overview, 'greenfield', 'orchestrator', 'cover:nobody')).toBeUndefined();
  });
});

describe('the Profiles poll on a generated cover (review F-4)', () => {
  it('keeps the identity text the cover shows, and refreshes it from disk', async () => {
    let onDisk = 'What it does, first.';
    vi.stubGlobal('window', { electronAPI: {
      profiles: {
        list: () => Promise.resolve({ success: true, data: overview }),
        read: () => Promise.resolve({ success: true, data: onDisk }),
      },
    } });
    const key = fileKey('greenfield', 'agents/orchestrator.md');
    useProfilesStore.setState({ overview, place: { level: 'profile', plugin: 'greenfield', profile: 'orchestrator', file: 'cover:' } });
    await useProfilesStore.getState().readFile('greenfield', 'agents/orchestrator.md');
    onDisk = 'What it does, changed outside Pane.';
    await useProfilesStore.getState().refresh();
    expect(useProfilesStore.getState().saved[key]).toBe('What it does, changed outside Pane.');
  });
});
