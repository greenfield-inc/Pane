import { describe, expect, it } from 'vitest';
import { isSavedUrlRequest, navigateRequestAction, webviewSrcFor, worktreeFileOf } from './browserNavigation';

describe('navigateRequestAction', () => {
  const tab = { panelId: 'tab-2', sessionId: 'session', shownUrl: 'http://localhost:5173/about' };

  it('leaves every tab but the named one alone', () => {
    expect(navigateRequestAction({ url: 'http://localhost:5173/', sessionId: 'session', panelId: 'tab-1' }, tab)).toBe('ignore');
    expect(navigateRequestAction({ url: 'http://localhost:5173/', sessionId: 'other', panelId: 'tab-2' }, tab)).toBe('ignore');
  });

  it('reloads only when the tab is already showing the page', () => {
    expect(navigateRequestAction({ url: 'http://localhost:5173/about', sessionId: 'session', panelId: 'tab-2' }, tab)).toBe('reload');
  });

  it('loads the requested page when a link took the tab somewhere else, even if it was the original URL', () => {
    expect(navigateRequestAction({ url: 'http://localhost:5173/', sessionId: 'session', panelId: 'tab-2' }, tab)).toBe('navigate');
  });
});

describe('isSavedUrlRequest', () => {
  it('treats a saved page the tab is showing as no request', () => {
    expect(isSavedUrlRequest('file:///site/about.html', { shownUrl: 'file:///site/about.html', pendingEchoes: new Set() })).toBe(false);
  });

  it('ignores the late echo of an earlier save after the person followed another link', () => {
    const pendingEchoes = new Set(['file:///site/about.html']);
    const tab = { shownUrl: 'file:///site/contact.html', pendingEchoes };
    expect(isSavedUrlRequest('file:///site/about.html', tab)).toBe(false);
    expect(pendingEchoes.size).toBe(0);
  });

  it('navigates for a saved URL someone else set', () => {
    expect(isSavedUrlRequest('http://localhost:3000/', { shownUrl: 'file:///site/about.html', pendingEchoes: new Set() })).toBe(true);
  });
});

describe('webviewSrcFor', () => {
  it('keeps the src when a ports update remaps where the same URL loads', () => {
    const first = webviewSrcFor('http://localhost:5173/', { kind: 'load', url: 'http://localhost:61000/' }, null);
    const afterPortsUpdate = webviewSrcFor('http://localhost:5173/', { kind: 'load', url: 'http://localhost:62000/' }, first);
    expect(afterPortsUpdate).toBe(first);
    expect(afterPortsUpdate?.src).toBe('http://localhost:61000/');
  });

  it('takes the new address when the tab is asked for a new URL', () => {
    const first = webviewSrcFor('http://localhost:5173/', { kind: 'load', url: 'http://localhost:61000/' }, null);
    expect(webviewSrcFor('http://localhost:5173/docs', { kind: 'load', url: 'http://localhost:62000/docs' }, first)?.src).toBe('http://localhost:62000/docs');
  });

  it('has no src while the address is unreachable', () => {
    expect(webviewSrcFor('http://localhost:5173/', { kind: 'waiting' }, null)).toBeNull();
  });
});

describe('worktreeFileOf', () => {
  it('finds a worktree file, including a URL-encoded name', () => {
    expect(worktreeFileOf('file:///repo/wt/site/my%20page.html', '/repo/wt')).toBe('site/my page.html');
  });

  it('handles Windows drive paths', () => {
    expect(worktreeFileOf('file:///C:/Repo/wt/site/index.html', 'c:\\repo\\wt\\')).toBe('site/index.html');
  });

  it('handles Windows UNC paths such as a WSL worktree, keeping the host', () => {
    expect(worktreeFileOf('file://wsl.localhost/Ubuntu/home/user/repo/site/index.html', '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo')).toBe('site/index.html');
    expect(worktreeFileOf('file://other-host/Ubuntu/home/user/repo/index.html', '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo')).toBeNull();
  });

  it.each([
    ['https://example.com/index.html', '/repo/wt'],
    ['file:///repo/wt-other/index.html', '/repo/wt'],
    ['file:///etc/hosts', '/repo/wt'],
    ['file:///repo/wt/index.html', undefined],
  ])('offers no source for %s', (pageUrl, worktreePath) => {
    expect(worktreeFileOf(pageUrl, worktreePath)).toBeNull();
  });
});
