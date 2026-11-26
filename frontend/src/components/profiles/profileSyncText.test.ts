import { describe, expect, it } from 'vitest';
import type { ProfileSyncStatus } from '../../../../shared/types/profileSync';
import { savedSyncText, syncFooterText, syncNowText, syncStateText } from './profileSyncText';

const status: ProfileSyncStatus = {
  running: false,
  lastSyncAt: 1,
  computers: [
    { key: 'b', id: 'b', name: 'build-box', state: 'up-to-date', waiting: [] },
    { key: 't', id: 't', name: 'travel-laptop', state: 'offline', waiting: ['writer'] },
  ],
};

describe('profile sync text', () => {
  it('says who has every save and what an offline computer gets when it reconnects', () => {
    expect(syncFooterText(status)).toBe('Synced to build-box · travel-laptop gets 1 change when it reconnects');
    expect(syncFooterText({ running: false, computers: [] })).toBe('No other computers to sync with');
    expect(syncFooterText({ ...status, computers: [{ key: 'o', id: 'o', name: 'old-mac', state: 'outdated', waiting: [] }] })).toBe('old-mac needs a newer Pane');
  });

  it('says when a computer has Profiles off, and sends it nothing', () => {
    const off: ProfileSyncStatus = { ...status, computers: [{ key: 'o', id: 'o', name: 'old-mac', state: 'off', waiting: [] }] };
    expect(syncFooterText(off)).toBe('old-mac has Profiles off');
    expect(syncStateText(off.computers[0])).toBe('Profiles is off there: turn it on in its Settings to sync');
    expect(savedSyncText(off)).toBe('');
  });

  it('gives each computer its state in the Sync sheet', () => {
    expect(status.computers.map(syncStateText)).toEqual(['Up to date (every save is pushed)', 'Offline: gets 1 change when it reconnects']);
  });

  it('names where a save goes, and what Sync now did', () => {
    expect(savedSyncText(status)).toBe(' Sending it to build-box; travel-laptop gets it when it reconnects.');
    expect(savedSyncText({ running: false, computers: [] })).toBe('');
    expect(syncNowText(status)).toBe('Sent all profiles to build-box; travel-laptop gets them when it reconnects.');
  });
});
