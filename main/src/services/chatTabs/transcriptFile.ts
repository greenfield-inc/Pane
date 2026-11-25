import fs from 'fs';
import path from 'path';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';

/** The folder in a Session folder that holds conversations saved for a new conversation to read (T-63). */
const TRANSCRIPTS_FOLDER = 'transcripts';

const divider = boundary.object({ type: boundary.literal('pane_divider'), text: boundary.string });

/**
 * A conversation as Markdown, for an agent to read: what the person wrote, what the agent answered, the
 * steps it took by title, and the profile dividers. Undefined when it has no message with words.
 */
export function transcriptMarkdown(messages: Iterable<AgentChatMessage>, agentName: string): string | undefined {
  const blocks: string[] = [];
  let last: string | undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      const line = part.type === 'text' ? part.text.trim()
        : part.type === 'tool' ? `- Step: ${part.title}`
        : part.type === 'content' ? dividerLine(part.content) : '';
      if (!line) continue;
      const heading = line.startsWith('---') ? undefined : message.role === 'user' ? '## The person' : `## ${agentName}`;
      if (heading && heading !== last) blocks.push(heading);
      last = heading ?? last;
      blocks.push(line);
    }
  }
  if (!blocks.some(block => !block.startsWith('#') && !block.startsWith('---'))) return undefined;
  return `# Earlier conversation\n\nPane saved this conversation for the agent that continues it.\n\n${blocks.join('\n\n')}\n`;
}

function dividerLine(content: JsonValue): string {
  const decoded = decodeOptionalBoundary(content, divider);
  return decoded ? `--- ${decoded.text} ---` : '';
}

/**
 * Writes `<folder>/transcripts/<name>.md` without following a link an agent put in its place: the folder
 * must be a real directory, and the file lands through a fresh temporary file renamed over the path.
 */
export function writeTranscriptFile(folder: string, name: string, content: string): string {
  const directory = path.join(folder, TRANSCRIPTS_FOLDER);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new PaneError('CHAT_TRANSCRIPT_NOT_SAVED', `${directory} is not a folder (it may be a link), so Pane did not save the conversation there.`, `Remove ${directory}, then try again.`);
  }
  const file = path.join(directory, `${name.replace(/[^A-Za-z0-9_-]/g, '_') || 'conversation'}.md`);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return file;
}

/** The first message of a new conversation that continues an old one from its transcript. */
export function transcriptPrompt(file: string, reason: string): string {
  return `${reason} The earlier conversation in this Session is saved in ${file}. Read it first, then carry on from where it left off.`;
}
