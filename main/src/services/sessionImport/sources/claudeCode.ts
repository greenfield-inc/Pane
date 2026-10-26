import fs from 'fs';
import path from 'path';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import { boundary, decodeOptionalBoundary } from '../../../../../shared/validation/boundaryDecoder';
import type { FoundSession, ReaderContext, SourceReader } from './types';
import { absent, claudeConfigDir, exists, mtimeMs, readHeadLines, readJson, readTailLines, unreadable } from './common';

// Claude Code 1.x-2.x keeps one JSONL transcript per session at
// `<config>/projects/<cwd with non-alphanumerics as '-'>/<session id>.jsonl`.
// Message lines carry `cwd`, `gitBranch`, `entrypoint`, `isSidechain` and
// `version`; titles are `custom-title` (`customTitle`) or `ai-title`
// (`aiTitle`) lines. `<config>/sessions/<pid>.json` lists running sessions.

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/iu;
const SUPPORTED_MAJOR_VERSIONS = new Set([1, 2]);

const text = boundary.optional(boundary.string);
const claudeLine = boundary.object({
  type: boundary.string,
  sessionId: text,
  cwd: text,
  gitBranch: text,
  entrypoint: text,
  version: text,
  customTitle: text,
  aiTitle: text,
  summary: text,
  lastPrompt: text,
  isSidechain: boundary.optional(boundary.boolean),
});
type ClaudeLine = NonNullable<ReturnType<typeof decodeClaudeLine>>;
type TextKey = 'cwd' | 'gitBranch' | 'entrypoint' | 'version' | 'customTitle' | 'aiTitle' | 'summary' | 'lastPrompt';

const registryEntry = boundary.object({ pid: boundary.optional(boundary.number), sessionId: text, cwd: text });

function decodeClaudeLine(line: string) {
  try {
    return decodeOptionalBoundary(JSON.parse(line), claudeLine);
  } catch {
    return undefined;
  }
}

interface LiveClaudeSession {
  pid: number;
  sessionId?: string;
  cwd?: string;
}

/**
 * Claude processes listed in `<config>/sessions/<pid>.json` whose pid is
 * alive, or undefined when this Claude Code keeps no such registry.
 */
export function liveClaudeSessions(context: ReaderContext, configDir: string): LiveClaudeSession[] | undefined {
  const dir = path.join(configDir, 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const live: LiveClaudeSession[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/u.exec(name);
    if (!match) continue;
    const entry = decodeOptionalBoundary(readJson(path.join(dir, name)), registryEntry);
    const pid = entry?.pid ?? Number(match[1]);
    if (!context.isPidAlive(pid)) continue;
    live.push({ pid, sessionId: entry?.sessionId || undefined, cwd: entry?.cwd || undefined });
  }
  return live;
}

/** Whether a Claude session is running, from the live registry. */
export function claudeRunning(live: LiveClaudeSession[] | undefined, sessionId: string, folder: string | undefined): ImportRunning {
  if (!live) return 'unknown';
  if (live.some(entry => entry.sessionId === sessionId)) return 'yes';
  // A live process that hasn't named its session yet could be this one.
  if (live.some(entry => !entry.sessionId && (!entry.cwd || entry.cwd === folder))) return 'unknown';
  return 'no';
}

/** The transcript of `sessionId` in `<configDir>/projects`, if there is one. */
export function findClaudeTranscript(configDir: string, sessionId: string, folder?: string): string | undefined {
  const projects = path.join(configDir, 'projects');
  const file = `${sessionId}.jsonl`;
  if (folder) {
    const direct = path.join(projects, folder.replace(/[^a-zA-Z0-9]/gu, '-'), file);
    if (exists(direct)) return direct;
  }
  for (const project of listDir(projects)) {
    const candidate = path.join(projects, project, file);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

interface TranscriptMeta {
  cwd?: string;
  branch?: string;
  title?: string;
  entrypoint?: string;
  version?: string;
  sidechain: boolean;
  recognised: boolean;
}

function lastString(lines: ClaudeLine[], key: TextKey): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = lines[index][key];
    if (value) return value;
  }
  return undefined;
}

function firstString(lines: ClaudeLine[], key: TextKey): string | undefined {
  return lines.find(line => line[key])?.[key];
}

function readTranscriptMeta(file: string): TranscriptMeta {
  const headLines = readHeadLines(file);
  const head = headLines.map(decodeClaudeLine).filter(line => line !== undefined);
  const tail = readTailLines(file).map(decodeClaudeLine).filter(line => line !== undefined);
  const both = [...head, ...tail];
  const prompt = lastString(tail, 'lastPrompt')?.split('\n')[0].trim();
  return {
    cwd: firstString(head, 'cwd'),
    branch: lastString(tail, 'gitBranch') ?? firstString(head, 'gitBranch'),
    title: lastString(both, 'customTitle') ?? lastString(both, 'aiTitle') ?? lastString(both, 'summary') ?? (prompt || undefined),
    entrypoint: firstString(head, 'entrypoint'),
    version: lastString(both, 'version'),
    sidechain: (headLines.length > 0 && decodeClaudeLine(headLines[0])?.isSidechain) === true,
    recognised: both.some(line => line.sessionId !== undefined),
  };
}

/** `claude -p` and Agent SDK runs record an `sdk-*` entrypoint. */
function isNonInteractive(entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && entrypoint.startsWith('sdk');
}

function majorVersion(version: string): number {
  return Number(version.split('.')[0]);
}

export const readClaudeCode: SourceReader = async context => {
  const configDir = claudeConfigDir(context);
  const projectsDir = path.join(configDir, 'projects');
  const registryDir = path.join(configDir, 'sessions');
  const storePaths = [projectsDir, registryDir];
  if (!exists(projectsDir)) return absent('claude', storePaths);

  const live = liveClaudeSessions(context, configDir);
  const sessions: FoundSession[] = [];
  let recognised = 0;
  let unrecognised = 0;
  for (const project of listDir(projectsDir)) {
    const projectDir = path.join(projectsDir, project);
    for (const name of listDir(projectDir)) {
      if (!SESSION_FILE.test(name)) continue;
      const file = path.join(projectDir, name);
      const lastActiveMs = mtimeMs(file);
      if (lastActiveMs === undefined || lastActiveMs < context.sinceMs) continue;

      const meta = readTranscriptMeta(file);
      if (!meta.recognised) {
        unrecognised += 1;
        continue;
      }
      recognised += 1;
      if (meta.version && !SUPPORTED_MAJOR_VERSIONS.has(majorVersion(meta.version))) {
        return unreadable('claude', `Claude Code ${meta.version} writes transcripts Pane doesn't know yet`, storePaths, meta.version);
      }
      if (meta.sidechain || isNonInteractive(meta.entrypoint)) continue;

      const sessionId = name.slice(0, -'.jsonl'.length);
      sessions.push({
        source: 'claude',
        agent: 'claude',
        sessionId,
        folder: meta.cwd,
        branch: meta.branch,
        title: meta.title,
        lastActiveMs,
        running: claudeRunning(live, sessionId, meta.cwd),
      });
    }
  }
  if (recognised === 0 && unrecognised > 0) {
    return unreadable('claude', 'Claude Code transcripts have a shape Pane doesn\'t recognise', storePaths);
  }
  return { source: 'claude', status: 'ok', storePaths, sessions };
};
