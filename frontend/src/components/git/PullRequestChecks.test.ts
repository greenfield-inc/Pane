import { describe, it, expect } from 'vitest';
import { parsePullRequestUrl } from './pullRequestUrl';

describe('parsePullRequestUrl', () => {
  it('reads the repository and number from a pull request url', () => {
    expect(parsePullRequestUrl('https://github.com/dcouple/Pane/pull/382')).toEqual({
      repo: 'dcouple/Pane',
      number: 382,
    });
  });

  it('ignores anything appended to the url', () => {
    expect(parsePullRequestUrl('https://github.com/o/r/pull/7/files#diff-abc')).toEqual({
      repo: 'o/r',
      number: 7,
    });
  });

  it('returns null for urls that are not pull requests', () => {
    expect(parsePullRequestUrl('https://github.com/dcouple/Pane/issues/12')).toBeNull();
    expect(parsePullRequestUrl('https://example.com/whatever')).toBeNull();
    expect(parsePullRequestUrl(undefined)).toBeNull();
    expect(parsePullRequestUrl('')).toBeNull();
  });
});
