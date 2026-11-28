import { describe, expect, it } from 'vitest';
import type { ProfileSubagentNode, ProfileTreeNode } from '../../../../shared/types/profileEditor';
import { LINK_MODE_SHORT, LINK_MODE_TEXT, coverFacts, directSubagents, findNode, isExpandable, previewKind, sandboxedHtml, splitFrontMatter, subagentLabel, subagentState, variantsText, visibleRows } from './profilePreview';

describe('previewKind', () => {
  it('previews HTML as a page, Markdown formatted, YAML as metadata, anything else as text', () => {
    expect(previewKind('covers/lead.html')).toBe('html');
    expect(previewKind('agents/lead.md')).toBe('markdown');
    expect(previewKind('profiles/lead.yaml')).toBe('yaml');
    expect(previewKind('pane.yml')).toBe('yaml');
    expect(previewKind('skills/plan/run.sh')).toBe('text');
  });
});

describe('splitFrontMatter', () => {
  it('separates front-matter from the body', () => {
    expect(splitFrontMatter('---\nharness: claude\n---\n\n# Lead\n')).toEqual({ frontMatter: 'harness: claude', body: '\n# Lead\n' });
    expect(splitFrontMatter('# No front-matter\n')).toEqual({ frontMatter: null, body: '# No front-matter\n' });
    expect(splitFrontMatter('---\nnever closed\n')).toEqual({ frontMatter: null, body: '---\nnever closed\n' });
  });
});

describe('sandboxedHtml', () => {
  it('adds a policy that blocks scripts and the network, keeping the page', () => {
    const page = sandboxedHtml('<html><head><title>x</title></head><body><h1>Lead</h1></body></html>');
    expect(page).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*">/);
    expect(page).not.toMatch(/script-src/);
    expect(page).toContain('<h1>Lead</h1>');
    expect(sandboxedHtml('<h1>Bare</h1>')).toMatch(/^<meta http-equiv="Content-Security-Policy"[^>]*><h1>Bare<\/h1>$/);
  });
});

const tree: ProfileTreeNode[] = [
  { kind: 'file', id: 'lead/identity', path: 'agents/lead.md', label: 'lead.md', note: 'identity' },
  { kind: 'folder', id: 'lead/skills', label: 'Skills', children: [
    { kind: 'folder', id: 'lead/skills/plan', label: 'plan', children: [{ kind: 'file', id: 'lead/skills/plan/SKILL.md', path: 'skills/plan/SKILL.md', label: 'SKILL.md' }] },
  ] },
  { kind: 'folder', id: 'lead/references', label: 'References', children: [{ kind: 'file', id: 'lead/references/style.md', path: 'references/lead/style.md', label: 'style.md' }] },
  { kind: 'folder', id: 'lead/subagents', label: 'Subagents', children: [
    { kind: 'subagent', id: 'lead/sub:planner', alias: 'planner', agent: 'team/planner', label: 'Planner', mode: 'native', harness: 'claude', identity: 'agents/planner.md', profile: 'team/planner', children: [
      { kind: 'file', id: 'lead/sub:planner/identity', path: 'agents/planner.md', label: 'planner.md', note: 'identity' },
      { kind: 'subagent', id: 'lead/sub:planner/sub:lead', alias: 'lead', agent: 'team/lead', label: 'Lead', mode: 'process', cycle: true, children: [] },
    ] },
    { kind: 'subagent', id: 'lead/sub:helper', alias: 'helper', agent: 'tools', label: 'helper', mode: 'launch', any: true, children: [] },
    { kind: 'subagent', id: 'lead/sub:gone', alias: 'gone', agent: 'team/gone', label: 'Gone', mode: 'native', error: 'team/gone is not an agent', children: [] },
  ] },
];

const subagent = (id: string): ProfileSubagentNode => {
  const node = findNode(tree, id);
  if (node?.kind !== 'subagent') throw new Error(`${id} is not a subagent`);
  return node;
};

describe('the profile tree', () => {
  it('lists a profile\'s skills, references and subagents for its generated cover', () => {
    expect(coverFacts(tree)).toEqual({
      skills: ['plan'], references: ['style.md'],
      subagents: [{ id: 'lead/sub:planner', label: 'Planner' }, { id: 'lead/sub:helper', label: 'any agent in tools' }, { id: 'lead/sub:gone', label: 'Gone' }],
    });
  });

  it('counts agents linked at the top of the tree as well as in Subagents', () => {
    const top: ProfileTreeNode = { kind: 'subagent', id: 'x', alias: 'x', agent: 'team/x', label: 'X', mode: 'process', children: [] };
    expect(directSubagents([...tree, top]).map(node => node.id)).toEqual(['lead/sub:planner', 'lead/sub:helper', 'lead/sub:gone', 'x']);
  });

  it('tells an agent, a link back, any agent of a plugin and a broken link apart', () => {
    expect(['lead/sub:planner', 'lead/sub:planner/sub:lead', 'lead/sub:helper', 'lead/sub:gone'].map(id => subagentState(subagent(id)))).toEqual(['agent', 'cycle', 'any', 'error']);
    expect(subagentLabel(subagent('lead/sub:helper'))).toBe('any agent in tools');
    expect(LINK_MODE_SHORT).toEqual({ native: 'inside parent', process: 'own process', launch: 'own launch' });
    expect(LINK_MODE_TEXT.native).toBe('Runs inside its parent');
    expect(variantsText(['claude', 'codex'], name => name.toUpperCase())).toBe('CLAUDE or CODEX');
    expect(variantsText(undefined, name => name)).toBeUndefined();
  });

  it('never expands a link back to an agent above it, nor an agent with nothing under it', () => {
    expect(isExpandable(subagent('lead/sub:planner'))).toBe(true);
    expect(isExpandable(subagent('lead/sub:planner/sub:lead'))).toBe(false);
    expect(isExpandable(subagent('lead/sub:helper'))).toBe(false);
    const looped = { ...subagent('lead/sub:planner/sub:lead'), children: [{ kind: 'file' as const, id: 'f', path: 'a.md', label: 'a.md' }] };
    expect(visibleRows([looped], new Set([looped.id])).map(row => row.node.id)).toEqual([looped.id]);
  });

  it('finds a node by id', () => {
    expect(findNode(tree, 'lead/sub:planner/identity')).toMatchObject({ path: 'agents/planner.md' });
    expect(findNode(tree, 'nope')).toBeUndefined();
  });

  it('shows only the rows of open folders, with their depth', () => {
    expect(visibleRows(tree, new Set(['lead/skills'])).map(row => `${row.depth}:${row.node.id}`)).toEqual([
      '0:lead/identity', '0:lead/skills', '1:lead/skills/plan', '0:lead/references', '0:lead/subagents',
    ]);
    expect(visibleRows(tree, new Set(['lead/subagents', 'lead/sub:planner'])).map(row => row.node.id)).toContain('lead/sub:planner/identity');
  });
});
