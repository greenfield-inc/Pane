import { constants } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NotifyInstructionsFile } from '../../../../shared/types/notify';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';

/**
 * A few lines in the agents' user-level instruction files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md)
 * that tell them to ask through `notify`. Only the lines between Pane's markers are ever written or
 * removed: every other byte, the line endings and any byte order mark stay as they were.
 */
export const NOTIFY_BLOCK_BEGIN = '<!-- pane-notify:begin (managed by Pane; edits are replaced) -->';
export const NOTIFY_BLOCK_END = '<!-- pane-notify:end -->';
/** Matches the begin marker whatever its note says, so a reworded marker is still found. */
const BEGIN_PREFIX = '<!-- pane-notify:begin';
const BOM = '﻿';

function renderBlock(): string[] {
  const { rules, cardRule, results } = RUNPANE_CONTRACT.agentContext.notifyGuidance;
  return [
    NOTIFY_BLOCK_BEGIN,
    '## Pane Notify',
    "When you need the person (a choice, an approval, a short answer), call the `pane` MCP's `notify` instead of asking in the terminal. If the tool isn't available, ignore this.",
    ...rules.map(rule => `- ${rule}`),
    `- ${results}`,
    cardRule,
    NOTIFY_BLOCK_END,
  ];
}

/**
 * Writes the block while Notify is on and removes it when Notify is off. A file is created only
 * when its agent's config folder exists; a symlinked file, a file that isn't UTF-8 and a file whose
 * markers don't pair up are left alone.
 */
export function syncNotifyInstructions(enabled: boolean, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): NotifyInstructionsFile[] {
  const targets = [
    { agent: 'Claude Code', dir: env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'), name: 'CLAUDE.md' },
    { agent: 'Codex', dir: env.CODEX_HOME?.trim() || path.join(home, '.codex'), name: 'AGENTS.md' },
  ] as const;
  return targets.map(({ agent, dir, name }) => {
    const file = path.join(dir, name);
    try {
      return { agent, file, state: syncFile(dir, file, enabled) };
    } catch (error) {
      const reason = error instanceof LeftAlone ? error.message
        : `Pane could not update it (${error instanceof Error ? error.message : String(error)}).`;
      console.warn(`[Notify] ${file}: ${reason}`);
      return { agent, file, state: 'skipped', reason };
    }
  });
}

/** A file Pane must not edit; the message says why. */
class LeftAlone extends Error {}

function syncFile(dir: string, file: string, enabled: boolean): NotifyInstructionsFile['state'] {
  if (!fs.existsSync(dir)) return 'not-found';
  const current = readText(file) ?? '';
  const next = editText(current, enabled);
  if (next !== current) {
    // Nothing but the block was in it: an empty file says no more than a missing one.
    if (next === '') fs.rmSync(file);
    else replaceFile(file, next);
  }
  return enabled ? 'written' : 'absent';
}

/** The file's text; undefined when it is missing. */
function readText(file: string): string | undefined {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink may point anywhere, so Pane never writes through one.
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // SAFETY: fs.openSync throws only Node system errors, which carry `code`.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new LeftAlone('It is a symlink, so Pane leaves it alone.');
    throw error;
  }
  let bytes: Buffer;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new LeftAlone('It is not a regular file, so Pane leaves it alone.');
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new LeftAlone("It isn't UTF-8 text, so Pane leaves it alone.");
  return text;
}

const bare = (line: string) => line.replace(/\r$/, '');
const blank = (line: string | undefined) => line === '' || line === '\r';

/** Adds, refreshes or removes the block: appended at the end when new, replaced where it stands otherwise. */
function editText(current: string, enabled: boolean): string {
  // A byte order mark stays where it is, outside the edit; none is ever added.
  const bom = current.startsWith(BOM) ? BOM : '';
  const body = current.slice(bom.length);
  const lines = body.split('\n');
  const begins = lines.flatMap((line, index) => (bare(line).trim().startsWith(BEGIN_PREFIX) ? [index] : []));
  const ends = lines.flatMap((line, index) => (bare(line).trim() === NOTIFY_BLOCK_END ? [index] : []));
  if (begins.length + ends.length > 0 && (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0])) {
    throw new LeftAlone("Pane's pane-notify markers in it don't pair up, so Pane leaves it alone. Remove the stray marker and turn Notify off and on.");
  }
  const at = begins.length ? { start: begins[0], end: ends[0] } : undefined;
  const crlf = body.includes('\r\n');
  let next: string;
  if (enabled && at) {
    const block = renderBlock().map(line => (crlf ? `${line}\r` : line));
    // A block that ends the file without a line break keeps ending it that way.
    if (at.end === lines.length - 1) block[block.length - 1] = bare(block[block.length - 1]);
    lines.splice(at.start, at.end - at.start + 1, ...block);
    next = lines.join('\n');
  } else if (enabled) {
    const eol = crlf ? '\r\n' : '\n';
    const added = renderBlock().join(eol);
    // A file without a final line break gets none after the block either, so removal gives it back as it was.
    next = !body ? `${added}\n` : body.endsWith('\n') ? `${body}${eol}${added}${eol}` : `${body}${eol}${eol}${added}`;
  } else if (at) {
    const start = at.start;
    lines.splice(start, at.end - start + 1);
    // Take back the blank line that set the block apart: the one before it at the end, a doubled one elsewhere.
    if (start === lines.length) {
      // The block ended the file without a line break, so did the text before it.
      if (start > 0 && blank(lines[start - 1])) {
        lines.splice(start - 1, 1);
        if (lines.length) lines[lines.length - 1] = bare(lines[lines.length - 1]);
      } else lines.push('');
    } else if (start === lines.length - 1 && lines[start] === '') {
      if (start > 0 && blank(lines[start - 1])) lines.splice(start - 1, 1);
    } else if (start < lines.length - 1 && blank(lines[start]) && (start === 0 || blank(lines[start - 1]))) lines.splice(start, 1);
    next = lines.join('\n');
  } else next = body;
  return bom + next;
}

/** Write beside the target and rename over it, so readers never see a partial file; keeps its mode. */
function replaceFile(file: string, text: string): void {
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // A new file.
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
