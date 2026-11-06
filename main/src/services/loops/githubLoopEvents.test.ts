import { describe, expect, it } from 'vitest';
import { GithubLoopEventSource, type GithubRestRead } from './githubLoopEvents';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

/** A fake GitHub REST API: path → body, answering 304 when the caller sends the last ETag. */
function fakeGithub(routes: Record<string, unknown>) {
  const reads: string[] = [];
  const rest: GithubRestRead = async (_host, path, etag) => {
    reads.push(path);
    const key = Object.keys(routes).find(route => path.startsWith(route));
    if (!key) throw new Error(`unexpected read ${path}`);
    const tag = `"${key}:${JSON.stringify(routes[key]).length}"`;
    return etag === tag ? { changed: false } : { changed: true, etag: tag, body: routes[key] as never };
  };
  return { rest, reads };
}

const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, html_url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, body: 'Adds a thing',
  created_at: at(5), updated_at: at(1), author_association: 'MEMBER', user: { login: 'maya' },
  head: { ref: `feature-${number}`, sha: `sha${number}`, repo: { full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } },
  ...extra,
});

describe('GithubLoopEventSource', () => {
  it('turns PR comments, reviews, failed checks, new PRs and labels into events with GitHub timestamps', async () => {
    const github = fakeGithub({
      '/repos/acme/app/issues/comments': [
        { id: 11, html_url: 'https://github.com/acme/app/pull/4#issuecomment-11', issue_url: 'https://api.github.com/repos/acme/app/issues/4', body: '/pane fix the flaky test', created_at: at(2), user: { login: 'maya' }, author_association: 'COLLABORATOR' },
        { id: 12, html_url: 'https://github.com/acme/app/issues/9#issuecomment-12', issue_url: 'https://api.github.com/repos/acme/app/issues/9', body: '/pane on an issue', created_at: at(2), user: { login: 'maya' }, author_association: 'OWNER' },
      ],
      '/repos/acme/app/pulls?': [pull(4), pull(5, { head: { ref: 'patch-1', sha: 'sha5', repo: { full_name: 'stranger/app' } }, author_association: 'NONE', user: { login: 'stranger' } })],
      '/repos/acme/app/pulls/4/reviews': [{ id: 21, state: 'CHANGES_REQUESTED', body: 'Please split this', submitted_at: at(3), user: { login: 'lee' }, author_association: 'MEMBER' }],
      '/repos/acme/app/pulls/5/reviews': [],
      '/repos/acme/app/commits/sha4/check-runs': { check_runs: [{ id: 31, name: 'test', status: 'completed', conclusion: 'failure', completed_at: at(4), html_url: 'https://github.com/acme/app/runs/31' }, { id: 32, name: 'lint', status: 'completed', conclusion: 'success', completed_at: at(4) }] },
      '/repos/acme/app/commits/sha5/check-runs': { check_runs: [] },
      '/repos/acme/app/issues/events': [{ id: 41, event: 'labeled', label: { name: 'agent' }, created_at: at(6), actor: { login: 'maya' }, issue: { number: 9, html_url: 'https://github.com/acme/app/issues/9', title: 'Crash on save', body: 'Steps to reproduce' } }],
    });
    const source = new GithubLoopEventSource(github.rest, () => NOW);

    const events = await source.poll('acme/app', { comments: true, reviews: true, checks: true, prs: true, labels: true });

    expect(events.map(({ event, collaborator }) => [event.key, event.kind, event.number, event.atMs, event.author, collaborator])).toEqual([
      ['label:41', 'label', 9, NOW - 6 * 60_000, 'maya', true],
      ['pr:4', 'pr', 4, NOW - 5 * 60_000, 'maya', true],
      ['pr:5', 'pr', 5, NOW - 5 * 60_000, 'stranger', false],
      ['check:31', 'check', 4, NOW - 4 * 60_000, null, true],
      ['review:21', 'review', 4, NOW - 3 * 60_000, 'lee', true],
      ['comment:11', 'comment', 4, NOW - 2 * 60_000, 'maya', true],
    ]);
    const byKey = new Map(events.map(({ event }) => [event.key, event]));
    expect(byKey.get('comment:11')).toMatchObject({ isPr: true, text: '/pane fix the flaky test', headRef: 'feature-4', fork: false, url: 'https://github.com/acme/app/pull/4#issuecomment-11' });
    expect(byKey.get('pr:5')).toMatchObject({ fork: true });
    expect(byKey.get('pr:5')?.headRef).toBeUndefined();
    expect(byKey.get('check:31')).toMatchObject({ summary: 'Check "test" failed', headRef: 'feature-4' });
    expect(byKey.get('review:21')).toMatchObject({ summary: '@lee requested changes', text: 'Please split this' });
    expect(byKey.get('label:41')).toMatchObject({ isPr: false, summary: 'Labeled agent', text: 'Crash on save\n\nSteps to reproduce' });
  });

  it('asks again with ETags, so an unchanged repo costs only 304s, and reuses the last answer', async () => {
    const github = fakeGithub({
      '/repos/acme/app/issues/comments': [{ id: 11, html_url: 'https://github.com/acme/app/pull/4#issuecomment-11', issue_url: 'https://api.github.com/repos/acme/app/issues/4', body: '/pane go', created_at: at(2), user: { login: 'maya' }, author_association: 'MEMBER' }],
      '/repos/acme/app/pulls?': [pull(4)],
      '/repos/acme/app/pulls/4/reviews': [],
    });
    const source = new GithubLoopEventSource(github.rest, () => NOW);
    const first = await source.poll('acme/app', { comments: true });
    const second = await source.poll('acme/app', { comments: true });
    expect(second).toEqual(first);
  });

  it('reads only what the loops on a repo ask for', async () => {
    const github = fakeGithub({ '/repos/acme/app/issues/events': [] });
    await new GithubLoopEventSource(github.rest, () => NOW).poll('acme/app', { labels: true });
    expect(github.reads).toEqual(['/repos/acme/app/issues/events?per_page=50']);
  });

  it('ignores events older than a day', async () => {
    const github = fakeGithub({ '/repos/acme/app/issues/events': [{ id: 41, event: 'labeled', label: { name: 'agent' }, created_at: at(25 * 60), actor: { login: 'maya' }, issue: { number: 9, html_url: 'u', title: 't', body: null } }] });
    expect(await new GithubLoopEventSource(github.rest, () => NOW).poll('acme/app', { labels: true })).toEqual([]);
  });
});
