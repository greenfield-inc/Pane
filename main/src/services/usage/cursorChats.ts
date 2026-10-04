import { basename, dirname } from 'path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

/** A Cursor chat Pane launched, and the worktree it ran in. */
export interface PaneCursorChat {
  chatId: string;
  cwd: string | null;
}

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The chat id a Cursor agent transcript belongs to: its file name
 * (`agent-transcripts/<chat>.jsonl`), or the folder holding it
 * (`agent-transcripts/<chat>/<file>.jsonl`). Null when neither is a chat id.
 */
export function cursorChatIdFromTranscript(path: string): string | null {
  const stem = basename(path, '.jsonl');
  if (CHAT_ID.test(stem)) return stem.toLowerCase();
  const folder = basename(dirname(path));
  return CHAT_ID.test(folder) ? folder.toLowerCase() : null;
}

/**
 * Cursor chats Pane launched: the chat id `cursorLaunch.ts` captured into a
 * Cursor panel's state, with its Pane's worktree. Archived Panes count while
 * their panels remain. Chats Pane did not launch, including the Cursor
 * editor's, never appear here.
 */
export function listPaneCursorChats(db: Database): PaneCursorChat[] {
  const rows = decodeBoundary(db.prepare(`
    SELECT chat_id, cwd FROM (
      -- CASE reads the JSON only once json_valid passes, so one damaged
      -- panel state cannot fail the whole query.
      SELECT CASE WHEN json_valid(tp.state) THEN json_extract(tp.state, '$.customState.agentType') END AS agent_type,
             CASE WHEN json_valid(tp.state) THEN json_type(tp.state, '$.customState.agentSessionId') END AS id_type,
             CASE WHEN json_valid(tp.state) THEN json_extract(tp.state, '$.customState.agentSessionId') END AS chat_id,
             s.worktree_path AS cwd,
             s.updated_at
      FROM tool_panels tp
      JOIN sessions s ON s.id = tp.session_id
    )
    WHERE agent_type = 'cursor' AND id_type = 'text'
    ORDER BY updated_at DESC
  `).all(), boundary.array(boundary.object({
    chat_id: boundary.string,
    cwd: boundary.nullable(boundary.string),
  })));

  const chats = new Map<string, PaneCursorChat>();
  for (const row of rows) {
    const chatId = row.chat_id.trim().toLowerCase();
    if (!CHAT_ID.test(chatId) || chats.has(chatId)) continue;
    chats.set(chatId, { chatId, cwd: row.cwd && row.cwd.length > 0 ? row.cwd : null });
  }
  return [...chats.values()];
}
