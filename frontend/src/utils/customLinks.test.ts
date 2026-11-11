import { describe, expect, it } from 'vitest';
import type { CustomLink } from '../../../shared/types/customLinks';
import { customLinkProblem, findCustomLinks } from '../../../shared/utils/customLinks';

function link(pattern: string, urlTemplate: string, overrides: Partial<CustomLink> = {}): CustomLink {
  return { enabled: true, id: pattern, label: 'Link', pattern, urlTemplate, ...overrides };
}

const JIRA = link('\\b(?:PROJ|OPS)-\\d+\\b', 'https://example.atlassian.net/browse/$0');

describe('findCustomLinks', () => {
  it('links every match with the whole match filled in', () => {
    expect(findCustomLinks('Fixes PROJ-12 and OPS-7, not XPROJ-1', [JIRA])).toEqual([
      { end: 13, start: 6, text: 'PROJ-12', url: 'https://example.atlassian.net/browse/PROJ-12' },
      { end: 23, start: 18, text: 'OPS-7', url: 'https://example.atlassian.net/browse/OPS-7' },
    ]);
  });

  it('fills in capture groups, encoded for a URL', () => {
    const search = link('ask:(\\w+)/(\\S+)', 'https://example.com/$1?q=$2&none=$3');
    expect(findCustomLinks('ask:docs/a&b', [search])).toEqual([
      { end: 12, start: 0, text: 'ask:docs/a&b', url: 'https://example.com/docs?q=a%26b&none=' },
    ]);
  });

  it('lets the first listed link win where two overlap, and orders matches by position', () => {
    const anyKey = link('[A-Z]+-\\d+', 'https://other.example.com/$0');
    expect(findCustomLinks('ABC-1 PROJ-2', [JIRA, anyKey]).map(match => match.url)).toEqual([
      'https://other.example.com/ABC-1',
      'https://example.atlassian.net/browse/PROJ-2',
    ]);
  });

  it('skips disabled and invalid links', () => {
    expect(findCustomLinks('PROJ-1', [
      { ...JIRA, enabled: false },
      link('(', 'https://example.com/$0'),
      link('PROJ-\\d+', 'javascript:alert($0)'),
    ])).toEqual([]);
  });

  it('ignores empty matches instead of looping on them', () => {
    expect(findCustomLinks('a PROJ-1', [link('(?=a)|PROJ-\\d', 'https://example.com/$0')]).map(match => match.text))
      .toEqual(['PROJ-1']);
  });
});

describe('customLinkProblem', () => {
  it('accepts a regular expression with a web link', () => {
    expect(customLinkProblem(JIRA)).toBeUndefined();
  });

  it('explains what is wrong with the pattern or the link', () => {
    expect(customLinkProblem(link('', 'https://example.com'))).toBe('Pattern is required');
    expect(customLinkProblem(link('(', 'https://example.com'))).toMatch(/^Not a regular expression: /);
    expect(customLinkProblem(link('a*', 'https://example.com'))).toBe('Pattern must not match empty text');
    expect(customLinkProblem(link('a', 'file:///etc/$0')))
      .toBe('Link must be a web address starting with http:// or https://');
  });
});
