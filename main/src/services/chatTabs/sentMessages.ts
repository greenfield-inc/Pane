import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** A message the agent was sent in another form than it was typed: its text, and the text parts sent. */
export interface SentMessage { sessionId: string; text: string; parts: string[] }

const schema = boundary.array(boundary.object({ sessionId: boundary.string, text: boundary.string, parts: boundary.array(boundary.string) }));
const KEPT = 400;
const KEPT_CHARACTERS = 2 * 1024 * 1024;

/**
 * What the person typed in messages whose skill was sent as its own part, one file per tab. The agent's
 * history gives back only the part it ran, so a reload shows these instead.
 */
export class SentMessages {
  constructor(private readonly file: (panelId: string) => string) {}

  of(panelId: string, sessionId: string | undefined): SentMessage[] {
    return sessionId ? this.read(panelId).filter(message => message.sessionId === sessionId) : [];
  }

  /** Best-effort: without it a reload shows the part the agent kept, and the message is still sent. */
  add(panelId: string, message: SentMessage): void {
    let kept = [...this.read(panelId), message].slice(-KEPT);
    while (kept.length > 1 && kept.reduce((sum, entry) => sum + entry.text.length * 2, 0) > KEPT_CHARACTERS) kept = kept.slice(1);
    const file = this.file(panelId);
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(kept), { mode: 0o600 });
    } catch (error) { console.warn(`[ChatTabs] ${panelId}: a sent message was not saved as typed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  remove(panelId: string): void {
    try { rmSync(this.file(panelId), { force: true }); }
    catch (error) { console.warn(`[ChatTabs] ${panelId}: its sent messages were not deleted: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private read(panelId: string): SentMessage[] {
    try { return decodeOptionalBoundary(JSON.parse(readFileSync(this.file(panelId), 'utf8')), schema) ?? []; }
    catch { return []; }
  }
}
