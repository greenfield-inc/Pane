import { createHash } from 'crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** A message the agent was sent in another form than it was typed: its text, and the text parts sent. */
export interface SentMessage { text: string; parts: string[] }

const schema = boundary.array(boundary.object({ text: boundary.string, parts: boundary.array(boundary.string) }));
const KEPT = 400;
const KEPT_CHARACTERS = 2 * 1024 * 1024;
/** Conversations kept; the least recently written go first. */
const KEPT_CONVERSATIONS = 500;

/**
 * What the person typed in messages whose skill was sent as its own part, one file per conversation, so
 * any tab that opens the conversation shows them. The agent's history gives back only the part it ran.
 */
export class SentMessages {
  constructor(private readonly directory: string) {}

  of(sessionId: string | undefined): SentMessage[] {
    if (!sessionId) return [];
    try { return decodeOptionalBoundary(JSON.parse(readFileSync(this.file(sessionId), 'utf8')), schema) ?? []; }
    catch { return []; }
  }

  /** Best-effort: without it a reload shows the part the agent kept, and the message is still sent. */
  add(sessionId: string, message: SentMessage): void {
    let kept = [...this.of(sessionId), message].slice(-KEPT);
    const size = (entries: SentMessage[]) => entries.reduce((sum, entry) => sum + (entry.text.length + entry.parts.join('').length) * 2, 0);
    while (kept.length > 1 && size(kept) > KEPT_CHARACTERS) kept = kept.slice(1);
    const file = this.file(sessionId);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.partial`, JSON.stringify(kept), { mode: 0o600 });
      renameSync(`${file}.partial`, file);
      this.prune();
    } catch (error) { console.warn(`[ChatTabs] A sent message was not saved as typed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private prune(): void {
    const names = readdirSync(this.directory).filter(name => name.endsWith('.json'));
    if (names.length <= KEPT_CONVERSATIONS) return;
    const oldest = names.map(name => ({ name, at: statSync(path.join(this.directory, name)).mtimeMs })).sort((a, b) => a.at - b.at);
    for (const { name } of oldest.slice(0, names.length - KEPT_CONVERSATIONS)) rmSync(path.join(this.directory, name), { force: true });
  }

  private file(sessionId: string): string {
    return path.join(this.directory, `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);
  }
}
