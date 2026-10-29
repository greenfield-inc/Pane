import { describe, expect, it } from 'vitest';

import { describeUpdateRow, type UpdateRowInput } from './updateRow';

const release: UpdateRowInput = {
  version: '1.2',
  updatesEnabled: true,
  isEmbeddedLaunch: true,
  isChecking: false,
  isDownloading: false,
  isUpdatePending: false,
  failed: false,
};
const onUpdate = { isEmbeddedLaunch: false, updateId: 'a1b2c3d4-0000-4000-8000-000000000000', createdAt: new Date(2026, 9, 28, 12) };

describe('describeUpdateRow', () => {
  it('names the bundle built into the app', () => {
    expect(describeUpdateRow(release)).toEqual({ kind: 'version', title: 'Version 1.2 · Built-in' });
  });

  it('names the running update by its short id and day', () => {
    expect(describeUpdateRow({ ...release, ...onUpdate })).toEqual({ kind: 'version', title: 'Version 1.2 · Update a1b2c3d · Oct 28' });
  });

  it('shows a check in progress', () => {
    expect(describeUpdateRow({ ...release, isChecking: true })).toEqual({ kind: 'checking', title: 'Checking for updates…' });
  });

  it('offers a restart once an update is downloaded, keeping the running one as context', () => {
    expect(describeUpdateRow({ ...release, ...onUpdate, isUpdatePending: true, isChecking: true }))
      .toEqual({ kind: 'restart', title: 'Restart to update', subtitle: 'Version 1.2 · Update a1b2c3d · Oct 28' });
  });

  it('says when the update server could not be reached', () => {
    expect(describeUpdateRow({ ...release, failed: true })).toEqual({
      kind: 'version',
      title: 'Version 1.2 · Built-in',
      subtitle: "Couldn't reach the update server. Tap to try again.",
    });
  });

  it('says a development build runs JavaScript from Metro', () => {
    expect(describeUpdateRow({ ...release, updatesEnabled: false, isUpdatePending: true }))
      .toEqual({ kind: 'version', title: 'Version 1.2 · Development build' });
  });
});
