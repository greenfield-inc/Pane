import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePlugin, ProfilesOverview } from '../../../shared/types/profileEditor';
import { displayedFile, fileKey, profilePhotoSource, profilePicture, useProfilesStore } from './profilesStore';

function plugin(name: string): ProfilePlugin {
  return { name, version: '0.1.0', bundled: false, edited: false, files: ['plugin.yaml'], profiles: [{ name, ref: `${name}/${name}`, entry: `agents/${name}.md`, harness: 'claude', tree: [] }] };
}

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
      tree: [{ kind: 'subagent', id: 'helper', alias: 'helper', agent: 'helper', label: 'Helper', harness: 'claude', identity: 'agents/helper.md', children: [] }],
    }],
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  useProfilesStore.setState({ overview: null, place: { level: 'list' }, saved: {}, drafts: {}, onDisk: {}, photos: { profiles: {}, sources: {} }, photosLoaded: false });
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

describe('profile photos', () => {
  const photos = {
    profiles: { 'greenfield/orchestrator': 'data:image/svg+xml;base64,AA==', 'greenfield/seo': 'data:image/svg+xml;base64,BB==' },
    sources: { 'greenfield/orchestrator': 'yours' as const, 'greenfield/seo': 'plugin' as const },
  };

  it('shows a profile\'s photo, variant or not, and says whether it is yours or the plugin\'s', () => {
    expect(profilePicture(photos, 'greenfield/orchestrator:codex')).toBe('data:image/svg+xml;base64,AA==');
    expect(profilePhotoSource(photos, 'greenfield/orchestrator')).toBe('yours');
    expect(profilePhotoSource(photos, 'greenfield/seo')).toBe('plugin');
  });

  it('shows initials for a profile with no photo', () => {
    expect(profilePicture(photos, 'greenfield/business')).toBeUndefined();
    expect(profilePicture(photos, undefined)).toBeUndefined();
    expect(profilePhotoSource(photos, 'greenfield/business')).toBe('default');
  });

  it('sends a photo as the SVG\'s text, then reads the photos again', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('window', { electronAPI: { profiles: {
      setPhoto: async (...args: unknown[]) => { sent.push(args); return { success: true }; },
      photos: async () => ({ success: true, data: photos }),
    } } });
    await useProfilesStore.getState().setPhoto('greenfield/seo', '<svg viewBox="0 0 1 1"/>');
    expect(sent).toEqual([['greenfield/seo', '<svg viewBox="0 0 1 1"/>']]);
    expect(useProfilesStore.getState().photos).toEqual(photos);
  });

  it('shows Agent Farm\'s reason when it refuses a photo', async () => {
    vi.stubGlobal('window', { electronAPI: { profiles: { setPhoto: async () => ({ success: false, error: 'The photo has a <script> element. Remove it, then try again.' }) } } });
    await expect(useProfilesStore.getState().setPhoto('greenfield/seo', '<svg><script/></svg>')).rejects.toThrow('The photo has a <script> element');
  });
});

describe('profilesStore refresh', () => {
  it('never undoes a new profile with a list read that started before it (QA round 2)', async () => {
    const before: ProfilesOverview = { machine: 'studio', plugins: [plugin('writer')] };
    let answerList: (value: { success: true; data: ProfilesOverview }) => void = () => undefined;
    vi.stubGlobal('window', { electronAPI: {
      profiles: {
        list: () => new Promise(resolve => { answerList = resolve; }),
        newProfile: async () => ({ success: true, data: { plugin: plugin('labtest'), path: 'agents/labtest.md' } }),
      },
    } });
    useProfilesStore.setState({ overview: before });
    const refreshing = useProfilesStore.getState().refresh();
    await useProfilesStore.getState().newProfile('labtest', 'claude');
    // The read that began before the new profile answers without it.
    answerList({ success: true, data: before });
    await refreshing;
    expect(useProfilesStore.getState().overview?.plugins.map(entry => entry.name)).toEqual(['writer', 'labtest']);
  });
});
