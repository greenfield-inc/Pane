import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnpushedWorkRows } from './UnpushedWorkGroup';
import type { RunpaneHostUnpushedItem } from '../../../../shared/types/runpaneOrchestration';

const text = (html: string) => html.replaceAll('&#x27;', "'").replace(/<[^>]+>/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);

const items: RunpaneHostUnpushedItem[] = [
  { paneId: 'a', paneName: 'fix-login', repoName: 'web', branch: 'fix-login', safetyCheck: { performed: true, unpushedCommits: 3, hasUncommittedChanges: true } },
  { paneId: 'b', paneName: 'docs', repoName: 'web', branch: null, safetyCheck: { performed: true, unpushedCommits: 1 } },
  { paneId: 'c', paneName: 'broken', repoName: 'web', branch: 'broken', safetyCheck: { performed: false, reason: 'git-error' } },
];

describe('Work not on GitHub rows', () => {
  it('lists each Pane with its branch and what is only on this machine', () => {
    expect(text(renderToStaticMarkup(<UnpushedWorkRows items={items} results={null} />))).toEqual([
      'fix-login', 'fix-login · 3 commits · uncommitted files',
      'docs', '1 commit',
      'broken', "broken · Couldn't check",
    ]);
  });

  it('says so when everything is on GitHub', () => {
    expect(text(renderToStaticMarkup(<UnpushedWorkRows items={[]} results={null} />))).toEqual(['Everything here is on GitHub.']);
  });

  it('shows what happened to each Pane in place of the list after Push all', () => {
    const markup = renderToStaticMarkup(<UnpushedWorkRows items={items} results={[
      { paneId: 'a', paneName: 'fix-login', outcome: 'pushed', committedWip: true, pushedTo: 'origin/fix-login' },
      { paneId: 'b', paneName: 'docs', outcome: 'failed', committedWip: false, message: 'Pull in docs and push again.' },
    ]} />);
    expect(text(markup)).toEqual([
      'fix-login', 'Committed as WIP and pushed to origin/fix-login',
      'docs', 'Failed: Pull in docs and push again.',
    ]);
  });
});
