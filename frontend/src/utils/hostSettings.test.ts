import { afterEach, describe, expect, it, vi } from 'vitest';
import { onOpenHostGitHubSettings, openHostGitHubSettings } from './hostSettings';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host GitHub settings', () => {
  it('opens Settings at Remote Access when asked, until unsubscribed', () => {
    vi.stubGlobal('window', new EventTarget());
    const open = vi.fn();
    const unsubscribe = onOpenHostGitHubSettings(open);

    openHostGitHubSettings();
    // On cloud sandboxes the credentials are the GitHub token field under Cloud sandboxes.
    expect(open).toHaveBeenCalledWith({ category: 'remote-access', setting: 'remote-cloud-github-token' });

    unsubscribe();
    openHostGitHubSettings();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
