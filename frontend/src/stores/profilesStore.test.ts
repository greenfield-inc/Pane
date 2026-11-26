import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfilePlugin, ProfilesOverview } from '../../../shared/types/profileEditor';
import { useProfilesStore } from './profilesStore';

function plugin(name: string): ProfilePlugin {
  return { name, version: '0.1.0', bundled: false, edited: false, files: ['plugin.yaml'], profiles: [{ name, ref: `${name}/${name}`, entry: `agents/${name}.md`, harness: 'claude', listed: true, uses: [], tree: [] }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  useProfilesStore.setState({ overview: null, place: { level: 'list' } });
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
