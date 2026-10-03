import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostFolderBrowserView } from './HostFolderBrowser';
import {
  hostFolderBrowserReducer,
  initialHostFolderBrowserState,
  visibleEntries,
  type HostFolderBrowserState,
} from '../utils/hostFolderBrowserState';
import type { BrowseDirectoriesResult } from '../../../shared/types/hostPaths';

const home: BrowseDirectoriesResult = {
  path: '/home/user',
  parent: '/home',
  home: '/home/user',
  platform: 'linux',
  entries: [
    { name: '.config', path: '/home/user/.config', isGitRepo: false, isHidden: true },
    { name: 'my-repo', path: '/home/user/my-repo', isGitRepo: true, isHidden: false },
    { name: 'notes', path: '/home/user/notes', isGitRepo: false, isHidden: false },
  ],
};

const loaded: HostFolderBrowserState = hostFolderBrowserReducer(
  hostFolderBrowserReducer(initialHostFolderBrowserState, { type: 'load-start' }),
  { type: 'load-success', listing: home },
);

function renderView(state: HostFolderBrowserState, allowCreate: boolean) {
  return renderToStaticMarkup(
    <HostFolderBrowserView
      hostName="sandbox-1"
      state={state}
      allowCreate={allowCreate}
      onOpenFolder={vi.fn()}
      onUp={vi.fn()}
      onToggleHidden={vi.fn()}
      onStartNewFolder={vi.fn()}
      onNewFolderNameChange={vi.fn()}
      onCreateFolder={vi.fn()}
      onCancelNewFolder={vi.fn()}
    />,
  );
}

describe('visibleEntries', () => {
  it('hides dot folders until asked', () => {
    expect(visibleEntries(home, false).map((entry) => entry.name)).toEqual(['my-repo', 'notes']);
    expect(visibleEntries(home, true).map((entry) => entry.name)).toEqual(['.config', 'my-repo', 'notes']);
  });
});

describe('hostFolderBrowserReducer', () => {
  it('starts hidden-folders-off with nothing loaded', () => {
    expect(initialHostFolderBrowserState).toEqual({
      listing: null, loading: false, error: null, showHidden: false, newFolderName: null,
    });
  });

  it('keeps the last listing while the next folder loads, and drops a stale error', () => {
    const failed = hostFolderBrowserReducer(loaded, { type: 'failure', error: 'Permission denied' });
    const reloading = hostFolderBrowserReducer(failed, { type: 'load-start' });
    expect(reloading).toMatchObject({ listing: home, loading: true, error: null });
  });

  it('shows a load failure without losing where the user was', () => {
    const failed = hostFolderBrowserReducer(
      hostFolderBrowserReducer(loaded, { type: 'load-start' }),
      { type: 'failure', error: '/nope does not exist on sandbox-1.' },
    );
    expect(failed).toMatchObject({ listing: home, loading: false, error: '/nope does not exist on sandbox-1.' });
  });

  it('toggles hidden folders without refetching state', () => {
    expect(hostFolderBrowserReducer(loaded, { type: 'toggle-hidden' }).showHidden).toBe(true);
  });

  it('names a new folder, keeps the name on a create failure, and clears it once the new folder loads', () => {
    const naming = hostFolderBrowserReducer(loaded, { type: 'new-folder-start' });
    expect(naming.newFolderName).toBe('');
    const typed = hostFolderBrowserReducer(naming, { type: 'new-folder-name', name: 'scratch' });
    const failed = hostFolderBrowserReducer(typed, { type: 'failure', error: 'scratch already exists.' });
    expect(failed).toMatchObject({ newFolderName: 'scratch', error: 'scratch already exists.' });
    const opened = hostFolderBrowserReducer(failed, {
      type: 'load-success',
      listing: { ...home, path: '/home/user/scratch', parent: '/home/user', entries: [] },
    });
    expect(opened).toMatchObject({ newFolderName: null, error: null });
    expect(hostFolderBrowserReducer(naming, { type: 'new-folder-cancel' }).newFolderName).toBeNull();
  });
});

describe('HostFolderBrowserView', () => {
  it('shows the current host folder, marks git repos, and hides dot folders by default', () => {
    const markup = renderView(loaded, false);
    expect(markup).toContain('aria-label="Current folder"');
    expect(markup).toContain('/home/user');
    expect(markup).toContain('aria-label="my-repo, git repo"');
    expect(markup).toContain('git repo');
    expect(markup).toContain('aria-label="notes"');
    expect(markup).not.toContain('.config');
  });

  it('lists dot folders once Show hidden folders is on', () => {
    const markup = renderView(hostFolderBrowserReducer(loaded, { type: 'toggle-hidden' }), false);
    expect(markup).toContain('aria-label=".config"');
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
  });

  it('offers Up only below the root', () => {
    expect(renderView(loaded, false)).toMatch(/<button[^>]*>.*Up<\/button>/s);
    const root = hostFolderBrowserReducer(loaded, { type: 'load-success', listing: { ...home, path: '/', parent: null } });
    expect(renderView(root, false)).toMatch(/<button[^>]*disabled=""[^>]*>.*Up<\/button>/s);
  });

  it('has no New folder control at all when creating is not allowed (Open)', () => {
    const markup = renderView(loaded, false);
    expect(markup).not.toContain('New folder');
  });

  it('offers New folder, then a name field and Create folder, when creating is allowed', () => {
    expect(renderView(loaded, true)).toContain('New folder');
    const naming = renderView(hostFolderBrowserReducer(loaded, { type: 'new-folder-start' }), true);
    expect(naming).toContain('aria-label="New folder name"');
    expect(naming).toContain('Create folder');
  });

  it('shows host errors inline as an alert', () => {
    const failed = hostFolderBrowserReducer(loaded, {
      type: 'failure',
      error: "That's a path on this computer; sandbox-1 is a Linux host. Pick a folder on sandbox-1.",
    });
    expect(renderView(failed, false)).toContain(
      'role="alert"',
    );
    expect(renderView(failed, false)).toContain('That&#x27;s a path on this computer; sandbox-1 is a Linux host. Pick a folder on sandbox-1.');
  });
});
