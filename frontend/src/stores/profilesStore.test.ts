import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePlugin, ProfilesOverview } from '../../../shared/types/profileEditor';
import { profilePhotoSource, profilePicture, useProfilesStore } from './profilesStore';

function plugin(name: string): ProfilePlugin {
  return { name, version: '0.1.0', bundled: false, edited: false, files: ['plugin.yaml'], profiles: [{ name, ref: `${name}/${name}`, entry: `agents/${name}.md`, harness: 'claude', tree: [] }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  useProfilesStore.setState({ overview: null, place: { level: 'list' }, photos: { profiles: {}, sources: {} }, photosLoaded: false });
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
