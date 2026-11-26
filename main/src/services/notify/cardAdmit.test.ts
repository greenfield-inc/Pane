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

  it('refuses a card whose links are full rather than claim a file it names was attached', () => {
    const links = Array.from({ length: 6 }, (_, index) => ({ label: `PR #${index}`, url: `https://github.com/org/repo/pull/${index}` }));
    const refused = refusalOf(() => admitCard({ title: 'Approve?', context: 'See /Users/me/x.md.', choices, links }, { files: disk(['/Users/me/x.md']) }));
    expect(refused?.code).toBe('ERR_NOTIFY_LINKS_FULL');
    expect(refused?.message).toContain('/Users/me/x.md');
    expect(refused?.next).toContain('--links');
  });

  it('reads a whole path in backticks or quotes, with spaces and Unicode, and matches it to its link', () => {
    const spaced = '/Users/me/My Documents/design.md';
    const unicode = '/Users/me/Résumé/çà.md';
    const files = disk([spaced, unicode, '/Users/me/My']);
    // Linked already: nothing to attach, and never checked as the truncated /Users/me/My.
    const linked = admitCard({ title: 'Approve the design?', context: `See \`${spaced}\`.`, choices, links: [{ label: 'Design', path: spaced }] }, { files });
    expect(linked.card.links).toEqual([{ label: 'Design', path: spaced }]);
    expect(linked.warnings.filter(warning => warning.startsWith('Attached'))).toEqual([]);
    // Not linked: the whole quoted path is attached, and a bare Unicode path is read to its end.
    const attached = admitCard({ title: 'Approve the design?', context: `See "${spaced}" and ${unicode}, then decide.`, choices }, { files });
    expect(attached.card.links).toEqual([{ label: 'design.md', path: spaced }, { label: 'çà.md', path: unicode }]);
  });

  it('strips trailing punctuation and a #section, and matches a link however its path is written', () => {
    const files = disk(['/Users/me/plan.md']);
    const admitted = admitCard({ title: 'Approve (see /Users/me/plan.md#goals)?', context: 'Read /Users/me/./plan.md!', choices, links: [{ label: 'Plan', path: '/Users/me/plan.md' }] }, { files });
    expect(admitted.card.links).toEqual([{ label: 'Plan', path: '/Users/me/plan.md' }]);
  });

  it('leaves relative paths, URLs and route or code examples alone, even under a folder that exists', () => {
    const admitted = admitCard({
      title: 'Ship the status endpoint?',
      context: 'It serves `/var/v1/status` and GET /var/v1/health from docs/api.md, as https://example.com/var/v1/status shows.',
      choices,
    }, { files: disk([], ['/var']) });
    expect(admitted.card.links).toBeUndefined();
    expect(admitted.warnings.filter(warning => /Attached|isn't on this computer/u.test(warning))).toEqual([]);
  });

  it('warns about, but posts, a file under a top folder this computer does not have', () => {
    const admitted = admitCard({ title: 'Approve the review?', context: 'The mock-up is /archive/review/mockup.html.', choices }, { files: disk(['/Users/me/a.md']) });
    expect(admitted.card.links).toBeUndefined();
    expect(admitted.warnings).toContainEqual(expect.stringContaining('/archive/review/mockup.html'));
  });

  it('checks only paths a new version adds, not those its earlier version already named', () => {
    const files = disk(['/Users/me/new.md']);
    const known = { title: 'Approve?', context: 'Old notes were in /Users/me/gone.md.' };
    const admitted = admitCard({ title: 'Approve?', context: 'Old notes were in /Users/me/gone.md. New ones: /Users/me/new.md.', choices }, { files, known });
    expect(admitted.card.links).toEqual([{ label: 'new.md', path: '/Users/me/new.md' }]);
    expect(admitted.attached).toEqual([{ label: 'new.md', path: '/Users/me/new.md' }]);
  });
});

function refusalOf(run: () => void): PaneError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof PaneError) return error;
    throw error;
  }
  return undefined;
}
