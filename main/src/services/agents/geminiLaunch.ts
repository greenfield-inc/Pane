import { closeSync, existsSync, openSync, readdirSync, readSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/** A launch command that already chooses its conversation; Pane leaves it as written. */
export const GEMINI_SESSION_SELECTOR = /(?:^|\s)(?:--resume|-r|--session-id|--session-file)(?:=|\s|$)/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function geminiTmpDirectory(home = process.env.GEMINI_CLI_HOME || homedir()): string {
  return path.join(home, '.gemini', 'tmp');
}

/** False when Pane cannot see Gemini's saved sessions (WSL, SSH, or a home set only in the user's shell). */
export function canReadGeminiSessions(): boolean {
  return existsSync(geminiTmpDirectory());
}

/**
 * Whether Gemini CLI saved a conversation under this id. Gemini writes
 * `<home>/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl`
 * on the first message, whose first line names the full `sessionId`; an idle
 * launch saves nothing. `--resume <id>` fails for an unsaved id and
 * `--session-id <id>` fails for a saved one, so the launch depends on this.
 */
export function hasGeminiSession(sessionId: string): boolean {
  if (!UUID.test(sessionId)) return false;
  const tmp = geminiTmpDirectory();
  if (!existsSync(tmp)) return false;
  const suffix = `-${sessionId.slice(0, 8).toLowerCase()}.jsonl`;
  for (const project of readdirSync(tmp, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const chats = path.join(tmp, project.name, 'chats');
    if (!existsSync(chats)) continue;
    for (const file of readdirSync(chats)) {
      if (!file.startsWith('session-') || !file.toLowerCase().endsWith(suffix)) continue;
      if (readHead(path.join(chats, file)).includes(`"sessionId":"${sessionId}"`)) return true;
    }
  }
  return false;
}

/** The first line is a short header; read only its start, not the whole conversation. */
function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n', 1)[0];
  } finally {
    closeSync(fd);
  }
}
