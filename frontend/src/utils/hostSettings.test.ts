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
    expect(open).toHaveBeenCalledWith({ category: 'remote-access' });

    unsubscribe();
    openHostGitHubSettings();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
