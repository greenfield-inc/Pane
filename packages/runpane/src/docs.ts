import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { RUNPANE_CONTRACT } from './generated/contract';

type DocKind = 'doc' | 'skill' | 'help' | 'command';

interface DocEntry {
  path: string;
  title: string;
  kind: DocKind;
  text: string;
}

const indexedDocSchema = boundary.array(boundary.object({ path: boundary.string, title: boundary.string, text: boundary.string }));
const DEFAULT_LIMIT = 5;
const EXCERPT_CHARS = 240;

/**
 * Everything `docs search` covers: docs/*.md (indexed at build time next to this file),
 * runpane help topics and per-command context from the contract, and the Pane Chat
 * skills the Pane app installed in its data directory.
 */
export function loadDocs(paneDir: string | undefined): DocEntry[] {
  const entries: DocEntry[] = [];
  const indexFile = path.join(__dirname, 'docs-index.json');
  if (fs.existsSync(indexFile)) {
    for (const doc of decodeBoundary(JSON.parse(fs.readFileSync(indexFile, 'utf8')), indexedDocSchema)) {
      entries.push({ ...doc, kind: 'doc' });
    }
  }
  for (const [topic, lines] of Object.entries(RUNPANE_CONTRACT.help.npm)) {
    entries.push({ path: `help/${topic}`, title: `runpane help ${topic}`, kind: 'help', text: lines.join('\n') });
  }
  for (const command of Object.values(RUNPANE_CONTRACT.agentContext.commands)) {
    const text = [
      command.summary,
      command.details,
      ...command.arguments.map((arg) => `${arg.name}${'value' in arg ? ` ${arg.value}` : ''}: ${arg.description}`),
      ...('notes' in command ? command.notes : []),
      ...command.examples,
    ].join('\n');
    entries.push({ path: `command/${command.name}`, title: `runpane ${command.name}`, kind: 'command', text });
  }
  const skillsDir = path.join(paneDir ?? process.env.PANE_DIR ?? path.join(os.homedir(), '.pane'), 'skills', 'pane-chat');
  for (const [dir, prefix] of [[path.join(skillsDir, 'skills'), 'skills'], [skillsDir, 'skills']] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(file) || entries.some((entry) => entry.path === `${prefix}/${name}/SKILL.md`)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const description = /^description:\s*"?(.+?)"?\s*$/m.exec(text);
      entries.push({ path: `${prefix}/${name}/SKILL.md`, title: description ? `${name}: ${description[1]}` : name, kind: 'skill', text });
    }
  }
  return entries;
}

export function runDocsSearch(parsed: ParsedArgs): number {
  const query = parsed.query?.trim();
  if (!query) throw new Error('runpane docs search requires --query.');
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 2))];
  const limit = Math.min(parsed.limit ?? DEFAULT_LIMIT, 20);
  const results = loadDocs(parsed.paneDir)
    .map((doc) => ({ doc, score: score(doc, terms) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
    .slice(0, limit)
    .map(({ doc }) => ({ path: doc.path, title: doc.title, kind: doc.kind, excerpt: excerpt(doc.text, terms) }));
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, query, results }, null, 2));
  } else if (results.length === 0) {
    console.log(`No Pane docs match "${query}". Try fewer or different words.`);
  } else {
    for (const result of results) console.log(`${result.path}\t${result.title}\n  ${result.excerpt}\n`);
  }
  return 0;
}

export function runDocsRead(parsed: ParsedArgs): number {
  const wanted = parsed.doc?.trim().replace(/^\/+/, '');
  if (!wanted) throw new Error('runpane docs read requires --doc.');
  const doc = loadDocs(parsed.paneDir).find((entry) => entry.path === wanted);
  if (!doc) {
    throw new Error(`No Pane doc at "${wanted}". Run \`runpane docs search --query <words>\` and use a path it returns.`);
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, path: doc.path, title: doc.title, kind: doc.kind, text: doc.text }, null, 2));
  } else {
    console.log(doc.text);
  }
  return 0;
}

function score(doc: DocEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = doc.title.toLowerCase();
  const text = doc.text.toLowerCase();
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    const inTitle = title.includes(term) ? 5 : 0;
    const inText = Math.min(text.split(term).length - 1, 10);
    if (inTitle + inText > 0) matched++;
    total += inTitle + inText;
  }
  // Documents that contain every word rank above partial matches.
  return matched === terms.length ? total + 100 : total;
}

function excerpt(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const at = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, at - EXCERPT_CHARS / 3);
  const slice = text.slice(start, start + EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${start + EXCERPT_CHARS < text.length ? '…' : ''}`;
}
