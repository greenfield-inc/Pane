import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateConversation, placeConversation } from './conversations';

const ID = '11111111-2222-4333-8444-555555555555';
let dir: string;
let a: NodeJS.ProcessEnv;
let b: NodeJS.ProcessEnv;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-move-conv-'));
  a = { HOME: path.join(dir, 'a/Users/alice') };
  b = { HOME: path.join(dir, 'b/Users/robert-b') };
  const projects = path.join(a.HOME!, '.claude/projects/-Users-alice-repos-app-worktrees-fix');
  write(path.join(projects, `${ID}.jsonl`), '{"turn":1}\n{"turn":2}\n');
  write(path.join(projects, ID, 'subagents/agent-1.jsonl'), '{"sub":1}\n');
  write(path.join(projects, `${ID}.lock`), 'pid');
  write(path.join(a.HOME!, '.claude/file-history', ID, 'v1'), 'old file');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Copies the located files into a fake package folder, as the transfer would. */
async function pack(env: NodeJS.ProcessEnv) {
  const located = await locateConversation('claude', ID, '/unused', 'conversations/tab-1', env);
  if (!located) throw new Error('not found');
  const packageRoot = path.join(dir, 'package');
  for (const [packagePath, source] of located.sources) write(path.join(packageRoot, packagePath), fs.readFileSync(source, 'utf8'));
  return { conversation: located.conversation, file: (packagePath: string) => path.join(packageRoot, packagePath) };
}

describe('moving a Claude conversation', () => {
  it('files it under the folder for the new working directory, byte for byte, without lock files', async () => {
    const { conversation, file } = await pack(a);
    expect(conversation.files.map(entry => `${entry.scope}:${entry.relative}`).sort()).toEqual([
      `project:${ID}.jsonl`, `project:${ID}/subagents/agent-1.jsonl`, `store:file-history/${ID}/v1`,
    ]);
    const placed = await placeConversation(conversation, file, '/Users/robert-b/code/app/worktrees/fix', { here: 'b', source: 'a' }, b);
    await placed.commit();
    const folder = path.join(b.HOME!, '.claude/projects/-Users-robert-b-code-app-worktrees-fix');
    expect(placed.mainPath).toBe(path.join(folder, `${ID}.jsonl`));
    expect(fs.readFileSync(placed.mainPath, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
    expect(fs.existsSync(path.join(folder, ID, 'subagents/agent-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(folder, `${ID}.lock`))).toBe(false);
    expect(fs.readFileSync(path.join(b.HOME!, '.claude/file-history', ID, 'v1'), 'utf8')).toBe('old file');
  });

  it('replaces an older copy in another folder, leaving exactly one copy', async () => {
    write(path.join(b.HOME!, '.claude/projects/-old-folder', `${ID}.jsonl`), '{"turn":1}\n');
    const { conversation, file } = await pack(a);
    const placed = await placeConversation(conversation, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b);
    await placed.commit();
    expect(fs.existsSync(path.join(b.HOME!, '.claude/projects/-old-folder', `${ID}.jsonl`))).toBe(false);
    expect(fs.readFileSync(placed.mainPath, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
  });

  it('refuses a copy that was continued on the target, and changes nothing', async () => {
    const theirs = path.join(b.HOME!, '.claude/projects/-Users-robert-b-new', `${ID}.jsonl`);
    write(theirs, '{"turn":1}\n{"turn":"continued on b"}\n');
    const { conversation, file } = await pack(a);
    await expect(placeConversation(conversation, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b)).rejects.toThrow(/history a's copy doesn't/);
    expect(fs.readFileSync(theirs, 'utf8')).toBe('{"turn":1}\n{"turn":"continued on b"}\n');
  });

  it('undo puts the target store back as it was', async () => {
    const theirs = path.join(b.HOME!, '.claude/projects/-Users-robert-b-new', `${ID}.jsonl`);
    write(theirs, '{"turn":1}\n');
    const { conversation, file } = await pack(a);
    const placed = await placeConversation(conversation, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b);
    await placed.undo();
    expect(fs.readFileSync(theirs, 'utf8')).toBe('{"turn":1}\n');
    expect(fs.existsSync(path.join(path.dirname(theirs), ID))).toBe(false);
  });

  it('refuses a package path that climbs out of the store, writing nothing outside it', async () => {
    const { conversation, file } = await pack(a);
    write(file('conversations/tab-1/store/evil'), 'export EVIL=1\n');
    const outside = path.join(b.HOME!, 'shell-rc-fixture');
    const hostile = { ...conversation, files: [...conversation.files, { package: 'conversations/tab-1/store/evil', scope: 'store' as const, relative: '../shell-rc-fixture' }] };
    await expect(placeConversation(hostile, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b)).rejects.toMatchObject({ code: 'ERR_MOVE_CONVERSATION_PATH' });
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(b.HOME!, '.claude'))).toBe(false);
    for (const relative of ['/etc/x', 'a//b', 'a\\..\\b', 'a/./b', '']) {
      const bad = { ...conversation, files: [{ package: 'conversations/tab-1/store/evil', scope: 'project' as const, relative }] };
      await expect(placeConversation(bad, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b)).rejects.toMatchObject({ code: 'ERR_MOVE_CONVERSATION_PATH' });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a path through a symlinked folder that leads out of the store', async () => {
    const { conversation, file } = await pack(a);
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(b.HOME!, '.claude/file-history'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(b.HOME!, '.claude/file-history', ID));
    await expect(placeConversation(conversation, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b)).rejects.toMatchObject({ code: 'ERR_MOVE_CONVERSATION_PATH' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.existsSync(path.join(b.HOME!, '.claude/projects'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('still files nested paths when the store itself is a symlink', async () => {
    const real = path.join(dir, 'dotfiles/claude');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(b.HOME!, { recursive: true });
    fs.symlinkSync(real, path.join(b.HOME!, '.claude'));
    const { conversation, file } = await pack(a);
    const placed = await placeConversation(conversation, file, '/Users/robert-b/new', { here: 'b', source: 'a' }, b);
    await placed.commit();
    expect(fs.readFileSync(path.join(real, 'projects/-Users-robert-b-new', ID, 'subagents/agent-1.jsonl'), 'utf8')).toBe('{"sub":1}\n');
    expect(fs.readFileSync(path.join(real, 'file-history', ID, 'v1'), 'utf8')).toBe('old file');
  });
});
