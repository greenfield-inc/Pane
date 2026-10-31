import { filePreviewKind } from '@shared/utils/filePreview';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** Text over this stays on the computer: the phone would download and draw it slowly. */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Images over this stay on the computer too. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface FileEntry {
  name: string;
  /** Relative to the worktree, with `/`. */
  path: string;
  isDirectory: boolean;
  size?: number;
}

const folderSchema = boundary.object({
  success: boundary.boolean,
  error: boundary.optional(boundary.string),
  files: boundary.optional(boundary.array(boundary.object({
    name: boundary.string,
    path: boundary.string,
    isDirectory: boundary.boolean,
    size: boundary.optional(boundary.number),
  }))),
});

/** `file:list`'s answer: the folder's entries, folders first. Throws the computer's reason when it refused. */
export function decodeFolder(response: unknown): FileEntry[] {
  const decoded = decodeOptionalBoundary(response, folderSchema);
  if (!decoded?.success || !decoded.files) throw new Error(decoded?.error ?? 'The computer sent a folder list Pane can’t read.');
  return decoded.files.map(({ name, path, isDirectory, size }) => (size === undefined ? { name, path, isDirectory } : { name, path, isDirectory, size }));
}

const searchSchema = boundary.object({
  success: boundary.boolean,
  error: boundary.optional(boundary.string),
  files: boundary.optional(boundary.array(boundary.object({ path: boundary.string, isDirectory: boundary.boolean }))),
});

/** `file:search`'s matches, as entries named by their last segment. */
export function decodeSearch(response: unknown): FileEntry[] {
  const decoded = decodeOptionalBoundary(response, searchSchema);
  if (!decoded?.success || !decoded.files) throw new Error(decoded?.error ?? 'The computer sent search results Pane can’t read.');
  return decoded.files.map(({ path, isDirectory }) => ({ name: path.split('/').pop() ?? path, path, isDirectory }));
}

const binarySchema = boundary.object({ success: boundary.boolean, contentBase64: boundary.optional(boundary.string), error: boundary.optional(boundary.string) });

/** `file:read-binary`'s answer: the file as base64. */
export function decodeBinary(response: unknown): string {
  const decoded = decodeOptionalBoundary(response, binarySchema);
  if (!decoded?.success || decoded.contentBase64 === undefined) throw new Error(decoded?.error ?? 'The computer sent a file Pane can’t read.');
  return decoded.contentBase64;
}

/** The folder a path sits in, `''` for the worktree's top. */
export function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

const textSchema = boundary.object({
  success: boundary.boolean,
  content: boundary.optional(boundary.string),
  binary: boundary.optional(boundary.boolean),
  error: boundary.optional(boundary.string),
});

/** `file:read`'s answer. A binary file is not an error: the viewer says it stays on the computer. */
export function decodeFileText(response: unknown): { kind: 'text'; content: string } | { kind: 'binary' } {
  const decoded = decodeOptionalBoundary(response, textSchema);
  if (decoded?.binary) return { kind: 'binary' };
  if (!decoded?.success || decoded.content === undefined) throw new Error(decoded?.error ?? 'The computer sent a file Pane can’t read.');
  return { kind: 'text', content: decoded.content };
}

/** How the phone shows a file: as code, rendered Markdown, a picture, or a card saying it stays on the computer. */
export type FileViewer = 'code' | 'markdown' | 'image' | 'stays';

export function fileViewer(path: string, size: number | undefined): FileViewer {
  const kind = filePreviewKind(path);
  if (kind === 'image') return size !== undefined && size > MAX_IMAGE_BYTES ? 'stays' : 'image';
  if (kind && kind !== 'markdown' && kind !== 'structured' && kind !== 'table') return 'stays';
  if (size !== undefined && size > MAX_TEXT_BYTES) return 'stays';
  return kind === 'markdown' ? 'markdown' : 'code';
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${round(bytes / (1024 * 1024))} MB`;
  return `${round(bytes / 1024)} KB`;
}

function round(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.max(0.1, Math.round(value * 10) / 10));
}

/** The path bar: the worktree's name, then each folder down to `path`. */
export function pathCrumbs(root: string, path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  return [{ name: root, path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))];
}

const LANGUAGES = {
  typescript: { label: 'TypeScript', grammar: typescript, extensions: ['ts', 'tsx', 'mts', 'cts'] },
  javascript: { label: 'JavaScript', grammar: javascript, extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  json: { label: 'JSON', grammar: json, extensions: ['json', 'jsonc', 'jsonl'] },
  python: { label: 'Python', grammar: python, extensions: ['py'] },
  bash: { label: 'Shell', grammar: bash, extensions: ['sh', 'bash', 'zsh'] },
  css: { label: 'CSS', grammar: css, extensions: ['css', 'scss'] },
  xml: { label: 'HTML', grammar: xml, extensions: ['html', 'htm', 'xml', 'svg', 'vue'] },
  yaml: { label: 'YAML', grammar: yaml, extensions: ['yml', 'yaml'] },
  markdown: { label: 'Markdown', grammar: markdown, extensions: ['md', 'markdown', 'mdx'] },
  go: { label: 'Go', grammar: go, extensions: ['go'] },
  rust: { label: 'Rust', grammar: rust, extensions: ['rs'] },
  swift: { label: 'Swift', grammar: swift, extensions: ['swift'] },
  kotlin: { label: 'Kotlin', grammar: kotlin, extensions: ['kt', 'kts'] },
  java: { label: 'Java', grammar: java, extensions: ['java'] },
  ruby: { label: 'Ruby', grammar: ruby, extensions: ['rb'] },
  sql: { label: 'SQL', grammar: sql, extensions: ['sql'] },
  c: { label: 'C', grammar: c, extensions: ['c', 'h'] },
  cpp: { label: 'C++', grammar: cpp, extensions: ['cc', 'cpp', 'hpp', 'cxx'] },
  diff: { label: 'Diff', grammar: diff, extensions: ['diff', 'patch'] },
} as const;
type LanguageId = keyof typeof LANGUAGES;

for (const [id, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(id, language.grammar);

export function languageOf(path: string): { id: LanguageId | null; label: string } {
  const name = path.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  for (const [id, language] of Object.entries(LANGUAGES) as Array<[LanguageId, (typeof LANGUAGES)[LanguageId]]>) {
    if ((language.extensions as readonly string[]).includes(ext)) return { id, label: language.label };
  }
  return { id: null, label: 'Text' };
}

/** A run of text, and the highlighter's scope for it (`keyword`, `string`, …) when it has one. */
export interface Token {
  text: string;
  scope?: string;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'' };

/** Highlights `code` and splits it into lines of tokens, so a long file can be a virtualized list. */
export function highlightLines(code: string, language: LanguageId | null): Token[][] {
  if (!language) return code.split('\n').map(line => (line ? [{ text: line }] : []));
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  const lines: Token[][] = [[]];
  const scopes: string[] = [];
  // highlight.js output is text and nested `<span class="hljs-…">`, with &, <, > and quotes escaped.
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (!part) continue;
    if (part.startsWith('<span')) {
      scopes.push(/class="hljs-([^ "]+)/.exec(part)?.[1] ?? '');
    } else if (part === '</span>') {
      scopes.pop();
    } else {
      const text = part.replace(/&(?:amp|lt|gt|quot|#x27);/g, entity => ENTITIES[entity]);
      const scope = scopes.at(-1);
      text.split('\n').forEach((piece, index) => {
        if (index > 0) lines.push([]);
        if (piece) lines[lines.length - 1].push(scope ? { text: piece, scope } : { text: piece });
      });
    }
  }
  return lines;
}
