import type { ProfileLinkMode, ProfileSubagentNode, ProfileTreeNode } from '../../../../shared/types/profileEditor';

export interface FrontMatterSplit {
  /** The YAML between the leading `---` lines; null when the file has none. */
  frontMatter: string | null;
  body: string;
}

export interface CoverFacts {
  skills: string[];
  references: string[];
  subagents: { id: string; label: string }[];
}

/**
 * The profile page's preview (T-63, build-6 feedback items 3-5): what kind of view a file gets, its
 * front-matter, a sandboxed HTML page, and the facts a generated cover lists.
 */

export type PreviewKind = 'html' | 'markdown' | 'yaml' | 'text';

export function previewKind(path: string): PreviewKind {
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  return 'text';
}

/** A Markdown file's front-matter (the YAML between its leading `---` lines) and its body. */
export function splitFrontMatter(source: string): FrontMatterSplit {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { frontMatter: null, body: source };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { frontMatter: null, body: source };
  const afterFence = text.indexOf('\n', end + 4);
  return { frontMatter: text.slice(4, end), body: afterFence < 0 ? '' : text.slice(afterFence + 1) };
}

/**
 * An HTML file as a page the preview frame can show safely: a Content-Security-Policy that loads
 * nothing from the network and runs no script (the frame's sandbox also forbids scripts), allowing
 * only its own styles and inline images.
 */
const POLICY = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">';

/** `baseCss` goes before the page's own styles (Pane's theme colours), so the page can override it. */
export function sandboxedHtml(html: string, baseCss = ''): string {
  const start = `${POLICY}${baseCss ? `<style>${baseCss.replace(/<\//g, '<\\/')}</style>` : ''}`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${start}${html.slice(head.index + head[0].length)}`;
  return `${start}${html}`;
}

/** The agents a profile links to directly: those in its Subagents folder, and any at the top of its tree. */
export function directSubagents(tree: readonly ProfileTreeNode[]): ProfileSubagentNode[] {
  const folder = tree.find(node => node.kind === 'folder' && node.label === 'Subagents');
  const inFolder = folder?.kind === 'folder' ? folder.children : [];
  return [...inFolder, ...tree].filter((node): node is ProfileSubagentNode => node.kind === 'subagent');
}

/** What a generated cover lists: the profile's skills, reference files and subagents (top level only). */
export function coverFacts(tree: readonly ProfileTreeNode[]): CoverFacts {
  const folder = (label: string) => tree.find((node): node is Extract<ProfileTreeNode, { kind: 'folder' }> => node.kind === 'folder' && node.label === label);
  const files = (nodes: readonly ProfileTreeNode[]): string[] => nodes.flatMap(node => (node.kind === 'file' ? [node.label] : node.kind === 'folder' ? files(node.children) : []));
  return {
    skills: (folder('Skills')?.children ?? []).map(node => node.label),
    references: files(folder('References')?.children ?? []),
    subagents: directSubagents(tree).map(node => ({ id: node.id, label: subagentLabel(node) })),
  };
}

/** What a linked agent is: an agent, a link back to one above it, any agent of a plugin, or a link that doesn't resolve. */
export type SubagentState = 'agent' | 'cycle' | 'any' | 'error';

export function subagentState(node: ProfileSubagentNode): SubagentState {
  if (node.error) return 'error';
  if (node.any) return 'any';
  if (node.cycle) return 'cycle';
  return 'agent';
}

/** A linked agent's name in the tree and on covers; an `any` link reads "any agent in <plugin>". */
export function subagentLabel(node: ProfileSubagentNode): string {
  return node.any ? `any agent in ${node.agent}` : node.label;
}

/** How its parent runs it (Agent Farm's link modes), as a sentence for the cover and the row's tooltip. */
export const LINK_MODE_TEXT = {
  native: 'Runs inside its parent',
  process: 'Runs as its own process',
  launch: 'Runs as its own launch, in a tab or headless',
} satisfies Record<ProfileLinkMode, string>;

/** The same, short, for the tree row. */
export const LINK_MODE_SHORT = {
  native: 'inside parent',
  process: 'own process',
  launch: 'own launch',
} satisfies Record<ProfileLinkMode, string>;

/** "Claude or Codex" for an agent with both variants; undefined for one with none. */
export function variantsText(variants: readonly string[] | undefined, label: (agent: string) => string): string | undefined {
  return variants?.length ? variants.map(label).join(' or ') : undefined;
}

/** Whether a tree row opens and closes: folders, and linked agents with rows under them (never a cycle). */
export function isExpandable(node: ProfileTreeNode): boolean {
  if (node.kind === 'file') return false;
  if (node.kind === 'subagent') return !node.cycle && node.children.length > 0;
  return true;
}

export function findNode(tree: readonly ProfileTreeNode[], id: string): ProfileTreeNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.kind !== 'file') {
      const inside = findNode(node.children, id);
      if (inside) return inside;
    }
  }
  return undefined;
}

export interface TreeRow {
  node: ProfileTreeNode;
  depth: number;
  /** The folder or subagent it sits in, for ← (go to parent). */
  parent?: string;
}

/** The rows the tree shows: every node whose folders are open, in order, with its depth. */
export function visibleRows(tree: readonly ProfileTreeNode[], open: ReadonlySet<string>, depth = 0, parent?: string): TreeRow[] {
  return tree.flatMap(node => {
    const row: TreeRow = { node, depth };
    if (parent) row.parent = parent;
    return [row, ...(isExpandable(node) && node.kind !== 'file' && open.has(node.id) ? visibleRows(node.children, open, depth + 1, node.id) : [])];
  });
}

/** The folders and subagents to open so `id` shows. */
export function ancestorsOf(tree: readonly ProfileTreeNode[], id: string, trail: string[] = []): string[] | undefined {
  for (const node of tree) {
    if (node.id === id) return trail;
    if (node.kind !== 'file') {
      const found = ancestorsOf(node.children, id, [...trail, node.id]);
      if (found) return found;
    }
  }
  return undefined;
}
