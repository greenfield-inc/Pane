import path from 'path';
import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { admitCard, type CardFiles } from './cardAdmit';

/** ~/notes/d.md under the fake home, joined as this platform joins it. */
const notes = path.join('/Users/me', 'notes/d.md');
const choices = [{ label: 'Ship it', detail: 'It goes out tonight.', recommended: true }, { label: 'Wait', detail: 'It waits a day.' }];

/** A disk with these files and folders; every folder above a file exists too. */
function disk(files: string[], folders: string[] = []): CardFiles {
  const dirs = new Set(folders);
  for (const file of files) {
    // Windows joins a ~/ path with backslashes; every folder above it exists in either form.
    const separator = file.includes('\\') ? '\\' : '/';
    const parts = file.split(separator);
    for (let end = 2; end < parts.length; end += 1) dirs.add(parts.slice(0, end).join(separator));
  }
  return {
    kind: (target) => (files.includes(target) ? 'file' : dirs.has(target) ? 'folder' : undefined),
    home: '/Users/me',
  };
}

describe('admitting a card that mentions files', () => {
  it('attaches a file the context names but no link opens, and says so', () => {
    const admitted = admitCard({ title: 'Approve the mock-ups?', context: 'Three options are in /Users/me/mock/index.html.', choices }, { files: disk(['/Users/me/mock/index.html']) });
    expect(admitted.card.links).toEqual([{ label: 'index.html', path: '/Users/me/mock/index.html' }]);
    expect(admitted.warnings).toEqual([expect.stringMatching(/^Attached \/Users\/me\/mock\/index\.html as a link/u)]);
  });

  it('attaches files named in the title, an option and a question, and a ~/ path, after the asker\'s own links', () => {
    const files = disk(['/Users/me/a.md', '/Users/me/b/c.md', notes, '/Users/me/e/f.html']);
    const admitted = admitCard({
      title: 'Ship /Users/me/a.md?',
      context: 'See ~/notes/d.md.',
      questions: [
        { title: 'Which copy, /Users/me/e/f.html?', choices },
        { title: 'Which build?', choices: [{ label: 'Keep', detail: 'Uses /Users/me/b/c.md', recommended: true }, { label: 'Drop', detail: 'Nothing.' }] },
      ],
      links: [{ label: 'PR #1', url: 'https://github.com/org/repo/pull/1' }],
    }, { files });
    expect(admitted.card.links).toEqual([
      { label: 'PR #1', url: 'https://github.com/org/repo/pull/1' },
      { label: 'a.md', path: '/Users/me/a.md' },
      { label: 'd.md', path: notes },
      { label: 'f.html', path: '/Users/me/e/f.html' },
      { label: 'c.md', path: '/Users/me/b/c.md' },
    ]);
  });

  it('leaves a linked file, a folder and a path that is not on this disk (an API route) alone', () => {
    const admitted = admitCard({
      title: 'Approve the plan?',
      context: 'The plan /Users/me/plan.md moves /api/v1/users into /Users/me/repo/src.',
      choices,
      links: [{ label: 'Plan', path: '/Users/me/plan.md' }],
    }, { files: disk(['/Users/me/plan.md'], ['/Users/me/repo/src']) });
    expect(admitted.card.links).toEqual([{ label: 'Plan', path: '/Users/me/plan.md' }]);
    expect(admitted.warnings.some(warning => warning.startsWith('Attached'))).toBe(false);
  });

  it('refuses a card naming a file that does not exist, naming --links and the path form', () => {
    let refusal: PaneError | undefined;
    try {
      admitCard({ title: 'Approve the mock-ups?', context: 'They are in /Users/me/mock/old.html.', choices }, { files: disk(['/Users/me/mock/index.html']) });
    } catch (error) {
      if (error instanceof PaneError) refusal = error;
    }
    expect(refusal?.code).toBe('ERR_NOTIFY_UNLINKED_PATH');
    expect(refusal?.message).toContain('/Users/me/mock/old.html');
    expect(refusal?.next).toContain('--links');
    expect(refusal?.next).toContain('{"label":"…","path":"/abs/path"}');
  });

  it('names a file with no room left on the card in its context rather than dropping it', () => {
    const links = Array.from({ length: 6 }, (_, index) => ({ label: `PR #${index}`, url: `https://github.com/org/repo/pull/${index}` }));
    const admitted = admitCard({ title: 'Approve?', context: 'See /Users/me/x.md.', choices, links }, { files: disk(['/Users/me/x.md']) });
    expect(admitted.card.links).toHaveLength(6);
    expect(admitted.card.context).toContain('More links: x.md');
  });
});
