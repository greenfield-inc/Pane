import { describe, expect, it } from 'vitest';
import { applyPick, commandRows, commandText, composerPlaceholder, detectComposerTrigger, fileReference, matchedParts, messageReferences, moveMarks } from '../../../../shared/composerMentions';
import { referencedFile } from './chatReferences';

/** `|` is the caret. */
const at = (marked: string) => {
  const caret = marked.indexOf('|');
  return detectComposerTrigger(marked.slice(0, caret) + marked.slice(caret + 1), caret);
};

describe('when the menu opens', () => {
  it.each([
    ['Why does @comp|', 'file', 'comp', 9],
    ['@|', 'file', '', 0],
    ['Fix this, then $s|', 'skill', 's', 15],
    ['Use €review|', 'skill', 'review', 4],
    ['then /si|', 'command', 'si', 5],
    ['/co|', 'command', 'co', 0],
    ['line\n/si|', 'command', 'si', 5],
  ])('%j', (text, kind, query, rangeStart) => {
    expect(at(text)).toMatchObject({ kind, query, rangeStart });
  });

  it.each([
    'https://runpane.com|', 'and/or|', 'src/app|', '5 / 2|', 'look in /usr/local|', 'then /a.b|', 'in /run/si|', 'then /|', 'then /5|', '(/si|',
    'costs $5|', '$10k|', 'me@example.com|', '`/simplify|', '`run @a|` now', '```\n@a|\n```', '~~~\n$b|', 'x @a done|',
  ])('not for %j', text => expect(at(text)).toBeNull());

  it('opens after code closes', () => {
    expect(at('`a` then @b|')).toMatchObject({ kind: 'file', query: 'b' });
    expect(at('```\ncode\n```\n$s|')).toMatchObject({ kind: 'skill', query: 's' });
  });
});

describe('what it lists and writes', () => {
  const commands = [
    { name: 'compact', description: 'Summarize' },
    { name: 'simplify', description: 'Review the changed code', skill: true as const },
    { name: 'review', description: 'Review a PR', skill: true as const },
    { name: 'Review', description: 'Listed twice', skill: true as const },
  ];
  const names = (text: string, mentions = { files: true as const, skills: true as const }) => commandRows(at(text)!, commands, mentions)?.map(command => command.name);

  it('orders name matches before description matches, once per name', () => {
    expect(names('$rev|')).toEqual(['review', 'simplify']);
    expect(names('/|')).toEqual(['compact', 'review', 'simplify']);
  });
  it('lists only skills whose name a mid-message / begins', () => {
    expect(names('then /si|')).toEqual(['simplify']);
    expect(names('then /co|')).toBeUndefined();
    expect(names('then /plify|')).toBeUndefined();
  });
  it('opens $ only for an agent that marks skills, and an older host offers a first-word / only', () => {
    expect(commandRows(at('$s|')!, commands, { files: true })).toBeUndefined();
    expect(commandRows(at('a /si|')!, commands, undefined)).toBeUndefined();
    expect(commandRows(at('/si|')!, commands, undefined)).toHaveLength(1);
    expect(commandRows(at('$nothing|')!, commands, { skills: true })).toEqual([]);
  });
  it('writes $name for a skill, /name for a command, and quotes a path a space would cut', () => {
    expect(commandText({ name: 'simplify', skill: true })).toBe('$simplify');
    expect(commandText({ name: '$codex-skill', skill: true })).toBe('$codex-skill');
    expect(commandText({ name: 'compact' })).toBe('/compact');
    expect(fileReference({ path: 'docs/my notes.md', isDirectory: false })).toBe('@"docs/my notes.md"');
    expect(fileReference({ path: 'native/src', isDirectory: true })).toBe('@native/src/');
    expect(fileReference({ path: 'docs/résumé.md', isDirectory: false })).toBe('@docs/résumé.md');
  });
  it('replaces the word at the caret and leaves one space', () => {
    expect(applyPick('then /si', at('then /si|')!, '$simplify')).toEqual({ text: 'then $simplify ', cursor: 15, mark: { start: 5, end: 14 } });
    expect(applyPick('a @c now', at('a @c| now')!, '@c.ts')).toEqual({ text: 'a @c.ts now', cursor: 8, mark: { start: 2, end: 7 } });
    // At the end of a line the caret stays on that line, after a new space.
    expect(applyPick('see @c\nnext', at('see @c|\nnext')!, '@c.ts')).toEqual({ text: 'see @c.ts \nnext', cursor: 10, mark: { start: 4, end: 9 } });
  });
  it('marks the matched letters of the last path segment typed', () => {
    expect(matchedParts('ChatComposer.tsx', 'comp')).toEqual([{ text: 'Chat', matched: false }, { text: 'Comp', matched: true }, { text: 'oser.tsx', matched: false }]);
    expect(matchedParts('abc.ts', 'src/ac')).toEqual([{ text: 'a', matched: true }, { text: 'b', matched: false }, { text: 'c', matched: true }, { text: '.ts', matched: false }]);
  });
});

describe('references', () => {
  const skills = new Set(['simplify', 'pane:work']);
  const found = (text: string) => messageReferences(text, skills).map(({ kind, start, end }) => [kind, text.slice(start, end)]);
  it.each([
    ['Why does @src/a.ts, wrap?', [['file', '@src/a.ts']]],
    ['See @README.md.', [['file', '@README.md']]],
    ['In @src/app/ now', [['folder', '@src/app/']]],
    ['Read @"docs/my notes.md", then $simplify.', [['file', '@"docs/my notes.md"'], ['skill', '$simplify']]],
    ['$pane:work: go', [['skill', '$pane:work']]],
    ['@Makefile and me@example.com and $unknown and $5', []],
    ['`@src/a.ts` and\n```\n$simplify\n```', []],
  ])('%j', (text, expected) => expect(found(text)).toEqual(expected));

  it('never leaves the folder when opened', () => {
    expect(referencedFile('src/a.ts', '/w/app', '/w')).toBe('app/src/a.ts');
    expect(referencedFile('./src/a.ts', '/w', '/w')).toBe('src/a.ts');
    for (const path of ['../a.ts', 'src/../../a.ts', '/etc/hosts', '~/a.ts', 'C:/a.ts', 'src\\..\\..\\a.ts']) expect(referencedFile(path, '/w', '/w')).toBeUndefined();
    expect(referencedFile('a.ts', '/elsewhere', '/w')).toBeUndefined();
  });
});

describe('highlight', () => {
  const marks = [{ start: 4, end: 10 }];
  it('moves with edits around a mark and goes with one inside it', () => {
    expect(moveMarks(marks, 'see @a.tsx ok', 'now see @a.tsx ok')).toEqual([{ start: 8, end: 14 }]);
    expect(moveMarks(marks, 'see @a.tsx ok', 'see @a.tsx okay')).toEqual(marks);
    expect(moveMarks(marks, 'see @a.tsx ok', 'see @a.ts ok')).toEqual([]);
    expect(moveMarks(marks, 'see @a.tsx ', 'see @a.tsxy ')).toEqual([]);
  });
});

it('names what the empty box can mention', () => {
  const all = { files: true as const, skills: true as const };
  expect(composerPlaceholder(all)).toBe('Ask anything, @ for files, $ for skills');
  expect(composerPlaceholder(all, { phone: true })).toBe('Ask anything, @ files, $ skills');
  expect(composerPlaceholder(all, { session: true })).toBe('Ask the Session anything, @ for files, $ for skills');
  expect(composerPlaceholder(all, { session: true, phone: true })).toBe('Ask the Session, @ files, $ skills');
  expect(composerPlaceholder({ files: true })).toBe('Ask anything, @ for files, / for commands');
  expect(composerPlaceholder(undefined)).toBe('Ask anything');
});
