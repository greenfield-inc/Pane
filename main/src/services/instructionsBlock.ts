import fs, { constants } from 'fs';

/**
 * Pane's one way to edit an instruction file someone else owns (CLAUDE.md, AGENTS.md and the like):
 * Pane owns exactly the bytes it wrote, its marked lines and, when it had to start a new line at the
 * end of the file for them, that one line break. Everything else, line endings and any byte order
 * mark included, stays as it was.
 */
export interface BlockMarkers {
  /** A line starting with this opens the block, so a reworded begin marker is still found. */
  begin: string;
  end: string;
  /** What the person does to repair markers that don't pair up, ending that sentence. */
  repair: string;
}

/** A file Pane must not edit; the message says why. */
export class LeftAlone extends Error {}

const BOM = '﻿';
/** Another program saves while Pane writes rarely more than once; past this, Pane tries at its next update. */
const WRITE_ATTEMPTS = 3;
/** An empty file saved this recently may be one another program truncated and is still writing. */
const JUST_SAVED_NS = 2_000_000_000n;
/** The empty file Pane itself last left at each path (inode and modified time), which the guard lets through. */
const emptiedByPane = new Map<string, { ino: bigint; mtimeNs: bigint }>();

export interface WriteOptions {
  /** Permission bits for a file Pane creates; an existing file keeps its own. */
  createMode?: number;
}

/**
 * Makes `block` (the marker lines included) the file's Pane-owned lines, or removes them when
 * `block` is undefined: appended at the end when new, replaced where they stand otherwise. Creates a
 * missing file, never deletes one. Returns whether the file changed. Throws LeftAlone for a symlink,
 * anything but a regular file, a file that isn't UTF-8, a file whose markers don't pair up, and an
 * empty file another program saved in the last moments.
 */
export function writeOwnedBlock(file: string, markers: BlockMarkers, block: string[] | undefined, { createMode = 0o644 }: WriteOptions = {}): boolean {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = readFile(file);
    if (block && current?.text === '' && BigInt(Date.now()) * 1_000_000n - current.mtimeNs < JUST_SAVED_NS && !isPanesOwnEmpty(file, current)) {
      throw new LeftAlone('It is empty and was saved just now, so another program may still be writing it. Pane tries again at its next update.');
    }
    const next = editText(current?.text ?? '', markers, block);
    if (next === (current?.text ?? '')) return false;
    if (commit(file, current, next, createMode)) {
      if (next === '') {
        const written = fs.lstatSync(file, { bigint: true });
        emptiedByPane.set(file, { ino: written.ino, mtimeNs: written.mtimeNs });
      }
      return true;
    }
  }
  throw new LeftAlone('It kept changing while Pane wrote to it, so Pane left it as it was. Pane tries again at its next update.');
}

function isPanesOwnEmpty(file: string, read: ReadFile): boolean {
  const own = emptiedByPane.get(file);
  return own !== undefined && own.ino === read.ino && own.mtimeNs === read.mtimeNs;
}

interface ReadFile {
  text: string;
  /** Which file the text came from, so Pane notices one saved in its place. */
  ino: bigint;
  mode: number;
  mtimeNs: bigint;
}

/** The file's text; undefined when it is missing. */
function readFile(file: string): ReadFile | undefined {
  let entry: fs.BigIntStats;
  try {
    // lstat first, on every platform: Windows has no O_NOFOLLOW, and opening a FIFO would wait forever.
    entry = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    // SAFETY: fs.lstatSync throws only Node system errors, which carry `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new LeftAlone('It is a symlink, so Pane leaves it alone.');
  if (!entry.isFile()) throw new LeftAlone('It is not a regular file, so Pane leaves it alone.');
  let fd: number;
  try {
    // Where the platform has them, these keep a path swapped since lstat from making Pane follow a link or wait.
    fd = fs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // SAFETY: fs.openSync throws only Node system errors, which carry `code`.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new LeftAlone('It is a symlink, so Pane leaves it alone.');
    throw error;
  }
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== entry.ino) return readFile(file);
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new LeftAlone("It isn't UTF-8 text, so Pane leaves it alone.");
  return { text, ino: entry.ino, mode: Number(entry.mode & 0o777n), mtimeNs: entry.mtimeNs };
}

/** Errors from link() on a filesystem without hard links (a WSL home over \\wsl.localhost, FAT or exFAT). */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EINVAL']);

/**
 * Puts `next` in place of the file Pane read. Returns false when another program changed or
 * replaced it meanwhile; their version is then back in place for Pane to start over from.
 */
function commit(file: string, read: ReadFile | undefined, next: string, createMode: number): boolean {
  const stamp = `${process.pid}.${Date.now()}`;
  const tmp = `${file}.${stamp}.tmp`;
  fs.writeFileSync(tmp, next, { mode: read?.mode ?? createMode, flag: 'wx' });
  try {
    if (!read) {
      // link() refuses to replace a file someone created since Pane looked.
      try {
        fs.linkSync(tmp, file);
        return true;
      } catch (error) {
        // SAFETY: fs.linkSync throws only Node system errors, which carry `code`.
        const { code } = error as NodeJS.ErrnoException;
        if (code === 'EEXIST') return false;
        if (!NO_HARD_LINKS.has(code ?? '')) throw error;
      }
      // No hard links here: an exclusive create refuses just the same.
      try {
        fs.writeFileSync(file, next, { mode: createMode, flag: 'wx' });
        return true;
      } catch (error) {
        // SAFETY: fs.writeFileSync throws only Node system errors, which carry `code`.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    }
    // A second name for the file Pane read: a save that lands on it during the swap survives there.
    const kept = `${file}.${stamp}.kept`;
    try {
      fs.linkSync(file, kept);
    } catch (error) {
      // SAFETY: fs.linkSync throws only Node system errors, which carry `code`.
      if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // Without hard links, Pane checks the file is still the one it read right before the swap.
      if (fs.lstatSync(file, { bigint: true }).ino !== read.ino || fs.readFileSync(file, 'utf8') !== read.text) return false;
      fs.renameSync(tmp, file);
      return true;
    }
    try {
      if (fs.lstatSync(file, { bigint: true }).ino !== read.ino) return false;
      fs.renameSync(tmp, file);
      if (fs.readFileSync(kept, 'utf8') === read.text) return true;
      fs.renameSync(kept, file);
      return false;
    } finally {
      fs.rmSync(kept, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const bare = (line: string) => line.replace(/\r$/, '');

/** Where Pane's bytes sit in the text; undefined when there is no block. */
function findOwned(body: string, markers: BlockMarkers): { start: number; end: number } | undefined {
  const lines: { start: number; text: string }[] = [];
  for (let start = 0; start <= body.length;) {
    const lineEnd = body.indexOf('\n', start);
    const end = lineEnd === -1 ? body.length : lineEnd;
    lines.push({ start, text: body.slice(start, end) });
    start = end + 1;
  }
  const begins = lines.filter(line => bare(line.text).trim().startsWith(markers.begin));
  const ends = lines.filter(line => bare(line.text).trim() === markers.end);
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || ends[0].start < begins[0].start) {
    throw new LeftAlone(`Pane's markers in it don't pair up, so Pane leaves it alone. Remove the stray marker and ${markers.repair}.`);
  }
  const start = begins[0].start;
  const endOfEndLine = ends[0].start + ends[0].text.length;
  if (endOfEndLine < body.length) return { start, end: endOfEndLine + 1 };
  // A block that ends the file without a line break: Pane started its line, so that break is Pane's too.
  const eol = begins[0].text.endsWith('\r') ? '\r\n' : '\n';
  return { start: body.slice(start - eol.length, start) === eol ? start - eol.length : start, end: body.length };
}

function editText(current: string, markers: BlockMarkers, block: string[] | undefined): string {
  // A byte order mark stays where it is, outside the edit; none is ever added.
  const bom = current.startsWith(BOM) ? BOM : '';
  const body = current.slice(bom.length);
  const owned = findOwned(body, markers);
  const own = owned ? body.slice(0, owned.start) + body.slice(owned.end) : body;
  if (!block) return bom + own;
  const at = owned?.start ?? own.length;
  const eol = own.includes('\r\n') ? '\r\n' : '\n';
  const text = block.join(eol);
  // At the end of text without a final line break, Pane starts the block's line and leaves the end as it found it.
  const startsLine = at === own.length && own !== '' && !own.endsWith('\n');
  return bom + own.slice(0, at) + (startsLine ? eol + text : text + eol) + own.slice(at);
}
