import fs from 'node:fs/promises';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';
import type { DirectoryEntry, DirectoryReadResult, SessionDirectory } from './types';

// The directory is written by `runpane cloud` on the user's machine (the single writer) and pushed here.
// A missing or unparsable file is a failed read, never "no Sessions": the reconciler must abort on it.
const directoryFileSchema = boundary.object({
  version: boundary.literal(1),
  generatedAt: boundary.optional(boundary.nullable(boundary.string)),
  sessions: boundary.array(boundary.object({
    sessionId: boundary.nonEmptyString,
    label: boundary.optional(boundary.string),
    provider: boundary.nonEmptyString,
    sandboxId: boundary.nonEmptyString,
    baseUrl: boundary.nonEmptyString,
    nodeId: boundary.optional(boundary.nullable(boundary.string)),
    pinnedVersion: boundary.optional(boundary.nullable(boundary.string)),
    coordinatorToken: boundary.optional(boundary.nullable(boundary.string)),
    org: boundary.optional(boundary.nullable(boundary.string)),
    github: boundary.optional(boundary.nullable(boundary.object({
      repos: boundary.optional(boundary.array(boundary.nonEmptyString)),
    }))),
    secretsManifest: boundary.optional(boundary.nullable(boundary.object({
      repo: boundary.nonEmptyString,
      ref: boundary.optional(boundary.nullable(boundary.string)),
    }))),
  })),
});

interface ParsedDirectory {
  generatedAt: string | null;
  entries: DirectoryEntry[];
}

export function parseDirectory(value: JsonValue): ParsedDirectory {
  const decoded = decodeBoundary(value, directoryFileSchema);
  const seen = new Set<string>();
  const entries = decoded.sessions.map((session): DirectoryEntry => {
    if (seen.has(session.sessionId)) throw new Error(`duplicate sessionId ${session.sessionId}`);
    seen.add(session.sessionId);
    return {
      sessionId: session.sessionId,
      label: session.label ?? session.sessionId,
      provider: session.provider,
      sandboxId: session.sandboxId,
      baseUrl: session.baseUrl.replace(/\/+$/, ''),
      nodeId: session.nodeId ?? null,
      pinnedVersion: session.pinnedVersion ?? null,
      coordinatorToken: session.coordinatorToken ?? null,
      org: session.org ?? null,
      githubRepos: session.github?.repos ?? [],
      secretsManifest: session.secretsManifest ? { repo: session.secretsManifest.repo, ref: session.secretsManifest.ref || null } : null,
    };
  });
  return { generatedAt: decoded.generatedAt ?? null, entries };
}

export interface DirectoryWriter {
  /** Validates and atomically replaces the directory; returns the number of Sessions. */
  replace(value: JsonValue): Promise<number>;
}

export class FileSessionDirectory implements SessionDirectory, DirectoryWriter {
  constructor(private readonly file: string) {}

  async replace(value: JsonValue): Promise<number> {
    const parsed = parseDirectory(value);
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.file);
    return parsed.entries.length;
  }

  async read(): Promise<DirectoryReadResult> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      return { ok: true, ...parseDirectory(JSON.parse(text)) };
    } catch (error) {
      return { ok: false, error: `directory ${this.file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/** Finds a directory entry by Session id, label, sandbox id or tailnet host name. */
export function findDirectoryEntry(entries: readonly DirectoryEntry[], host: string): DirectoryEntry | null {
  const wanted = host.trim().toLowerCase();
  if (wanted.length === 0) return null;
  return entries.find((entry) => (
    entry.sessionId.toLowerCase() === wanted
    || entry.label.toLowerCase() === wanted
    || entry.sandboxId.toLowerCase() === wanted
    || hostNameOf(entry.baseUrl) === wanted
    || hostNameOf(entry.baseUrl).split('.')[0] === wanted
  )) ?? null;
}

function hostNameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}
