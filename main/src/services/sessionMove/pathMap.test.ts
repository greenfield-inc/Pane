import { describe, expect, it } from 'vitest';
import { claudeProjectDirName } from '../agentTranscript/claude';
import { buildPathMap, rewriteJson, mapPath, rewriteText } from './pathMap';

const map = buildPathMap({
  sourceHome: '/Users/tylerbrown',
  targetHome: '/Users/tbrownio',
  entries: [
    { from: '/Users/tylerbrown/repos/greenfield/pane', to: '/Users/tbrownio/code/pane' },
    { from: '/Users/tylerbrown/repos/greenfield/pane/worktrees/fix-login', to: '/Users/tbrownio/elsewhere/fix-login' },
    { from: '/Users/tylerbrown/.pane/', to: '/Users/tbrownio/.pane' },
  ],
});

describe('mapPath', () => {
  it('maps a worktree through its own entry, longest prefix first', () => {
    expect(mapPath(map, '/Users/tylerbrown/repos/greenfield/pane/worktrees/fix-login/src/a.ts'))
      .toBe('/Users/tbrownio/elsewhere/fix-login/src/a.ts');
  });

  it('maps a repo path, and anything else under home through the home entry', () => {
    expect(mapPath(map, '/Users/tylerbrown/repos/greenfield/pane/README.md')).toBe('/Users/tbrownio/code/pane/README.md');
    expect(mapPath(map, '/Users/tylerbrown/notes/todo.md')).toBe('/Users/tbrownio/notes/todo.md');
    expect(mapPath(map, '/Users/tylerbrown')).toBe('/Users/tbrownio');
  });

  it('matches whole path segments only', () => {
    const short = buildPathMap({ sourceHome: '/Users/tyler', targetHome: '/home/robert-b', entries: [] });
    expect(mapPath(short, '/Users/tylerbrown/repos')).toBeNull();
    expect(mapPath(short, '/Users/tyler/repos')).toBe('/home/robert-b/repos');
  });

  it('ignores trailing slashes on entries and keeps them on the path', () => {
    expect(mapPath(map, '/Users/tylerbrown/.pane/sessions/')).toBe('/Users/tbrownio/.pane/sessions/');
  });

  it('leaves paths outside every entry alone', () => {
    expect(mapPath(map, '/opt/homebrew/bin/git')).toBeNull();
  });
});

describe('rewriteText', () => {
  it('rewrites every path in text, including file:// links', () => {
    const text = 'See /Users/tylerbrown/repos/greenfield/pane/worktrees/fix-login/a.md and [link](file:///Users/tylerbrown/.pane/sessions/x/index.html).';
    expect(rewriteText(map, text)).toBe('See /Users/tbrownio/elsewhere/fix-login/a.md and [link](file:///Users/tbrownio/.pane/sessions/x/index.html).');
  });

  it('does not rewrite a longer name that only starts like an entry', () => {
    const short = buildPathMap({ sourceHome: '/Users/tyler', targetHome: '/home/robert-b', entries: [] });
    expect(rewriteText(short, '"/Users/tylerbrown/x" "/Users/tyler/x" /Users/tyler')).toBe('"/Users/tylerbrown/x" "/home/robert-b/x" /home/robert-b');
  });

  it('does not rewrite a path nested inside another path', () => {
    expect(rewriteText(map, '/Volumes/backup/Users/tylerbrown/x')).toBe('/Volumes/backup/Users/tylerbrown/x');
  });

  it('rewrites launch command arguments', () => {
    expect(rewriteText(map, "agent-farm run greenfield/implementer:opus --arg parent=/Users/tylerbrown/.pane/sessions/s/status/a.json --settings '/Users/tylerbrown/x.json'"))
      .toBe("agent-farm run greenfield/implementer:opus --arg parent=/Users/tbrownio/.pane/sessions/s/status/a.json --settings '/Users/tbrownio/x.json'");
  });

  it("rewrites Claude's project folder names", () => {
    expect(rewriteText(map, '~/.claude/projects/-Users-tylerbrown-repos-greenfield-pane-worktrees-fix-login/abc.jsonl'))
      .toBe('~/.claude/projects/-Users-tbrownio-elsewhere-fix-login/abc.jsonl');
  });

  it("rewrites a project folder name encoded the way Claude encodes it, beyond the BMP too", () => {
    const rocket = buildPathMap({ sourceHome: '/Users/tylerbrown', targetHome: '/Users/tbrownio', entries: [{ from: '/work/🚀', to: '/Users/tbrownio/work/🚀' }] });
    expect(claudeProjectDirName('/work/🚀')).toBe('-work--');
    expect(rewriteText(rocket, `~/.claude/projects/${claudeProjectDirName('/work/🚀')}/abc.jsonl`))
      .toBe(`~/.claude/projects/${claudeProjectDirName('/Users/tbrownio/work/🚀')}/abc.jsonl`);
  });

  it('rewrites JSON value by value, so a target path with a backslash or quote stays valid JSON', () => {
    const odd = buildPathMap({ sourceHome: '/a', targetHome: 'C:\\Users\\b "q"', entries: [] });
    const state = { cwd: '/a/repo', url: 'file:///a/repo/x.html', nested: [{ path: '/a/y' }], n: 2, flag: true, none: null };
    expect(rewriteJson(odd, state)).toEqual({ cwd: 'C:\\Users\\b "q"/repo', url: 'file://C:\\Users\\b "q"/repo/x.html', nested: [{ path: 'C:\\Users\\b "q"/y' }], n: 2, flag: true, none: null });
  });
});
