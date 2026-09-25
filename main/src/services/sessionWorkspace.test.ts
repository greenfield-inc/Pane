import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { readSessionProgress } from './sessionProgress';
import { prepareSessionWorkspace, sessionWorkspacePath, isPristineSessionWorkspace } from './sessionWorkspace';

describe('Session workspace instructions', () => {
  const previousPaneDir = process.env.PANE_DIR;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-session-workspace-'));
    process.env.PANE_DIR = root;
  });

  afterEach(async () => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('allocates distinct stable folders and keeps opaque IDs inside the managed root', async () => {
    const first = prepareSessionWorkspace('session-a');
    const second = prepareSessionWorkspace('session-b');
    const unusual = prepareSessionWorkspace('../session/a');
    expect(first).not.toBe(second);
    expect(path.dirname(unusual)).toBe(path.join(root, 'sessions'));
    expect(unusual).not.toBe(prepareSessionWorkspace('..%2Fsession%2Fa'));
    await fs.writeFile(path.join(first, 'notes.md'), 'Keep this artifact.');
    expect(prepareSessionWorkspace('session-a', 'Updated behavior.')).toBe(first);
    expect(sessionWorkspacePath('session-a')).toBe(first);
    await expect(fs.readFile(path.join(first, 'notes.md'), 'utf8')).resolves.toBe('Keep this artifact.');
  });

  it.each(['AGENTS.md', 'CLAUDE.md', 'progress.html', 'notes.txt'])('preserves imports with user content in %s', async fileName => {
    const record: OrchestrationSessionRecord = {
      id: 'imported', name: 'Pane Chat · Codex', agent: 'codex', internalSessionId: 'owner',
      panelIds: { claude: 'claude', codex: 'codex', cursor: 'cursor' },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: [], activity: [], revision: 1, createdAt: '2026-09-21', updatedAt: '2026-09-21',
    };
    expect(isPristineSessionWorkspace(record)).toBe(true);
    const cwd = prepareSessionWorkspace(record.id, undefined, record);
    expect(isPristineSessionWorkspace(record)).toBe(true);
    prepareSessionWorkspace(record.id, undefined, record, false);
    expect(isPristineSessionWorkspace(record)).toBe(true);
    const file = path.join(cwd, fileName);
    await fs.appendFile(file, 'Keep my user content');
    const edited = await fs.readFile(file, 'utf8');
    expect(isPristineSessionWorkspace(record)).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
  });

  it('rejects private storage inside a repository or linked worktree', async () => {
    for (const marker of ['directory', 'file']) {
      const repo = path.join(root, marker);
      await fs.mkdir(repo);
      if (marker === 'directory') await fs.mkdir(path.join(repo, '.git'));
      else await fs.writeFile(path.join(repo, '.git'), 'gitdir: /somewhere');
      process.env.PANE_DIR = path.join(repo, 'private');
      expect(() => prepareSessionWorkspace('unsafe')).toThrow('outside Git worktrees');
      expect(await fs.readdir(repo)).toEqual(['.git']);
    }
    const alias = path.join(root, 'alias');
    await fs.symlink(path.join(root, 'directory'), alias);
    process.env.PANE_DIR = alias;
    expect(() => prepareSessionWorkspace('unsafe')).toThrow('outside Git worktrees');
  });

  it('replaces generated instructions while preserving user text and Claude imports', async () => {
    const cwd = prepareSessionWorkspace('session-a', 'Original profile.');
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const original = await fs.readFile(agentsPath, 'utf8');
    await fs.writeFile(agentsPath, `User preface.\n${original}\nUser footer.\n`);
    const claudePath = path.join(cwd, 'CLAUDE.md');
    await fs.appendFile(claudePath, '\nUser Claude instructions.\n');
    prepareSessionWorkspace('session-a', 'Revised profile.');
    prepareSessionWorkspace('session-a', 'Revised profile.');
    const agents = await fs.readFile(agentsPath, 'utf8');
    expect(agents).toContain('User preface.');
    expect(agents).toContain('User footer.');
    expect(agents).toContain('Revised profile.');
    expect(agents).not.toContain('Original profile.');
    expect(agents.match(/pane-session-context:start/g)).toHaveLength(1);
    expect(agents).toContain('Opening it does not authorize work. Await user input.');
    expect(agents).toContain('PANE_ORCHESTRATION_SESSION_ID');
    const claude = await fs.readFile(claudePath, 'utf8');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).toContain('User Claude instructions.');
    expect(claude.match(/pane-session-context:start/g)).toHaveLength(1);
  });

  it('refuses to overwrite instructions with incomplete managed markers', async () => {
    const cwd = prepareSessionWorkspace('session-a');
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const broken = 'User content.\n<!-- pane-session-context:start -->\nIncomplete';
    await fs.writeFile(agentsPath, broken);
    expect(() => prepareSessionWorkspace('session-a')).toThrow('markers are incomplete');
    await expect(fs.readFile(agentsPath, 'utf8')).resolves.toBe(broken);
  });
  it('updates progress guidance and status without deleting the document', async () => {
    const cwd = prepareSessionWorkspace('progress');
    await fs.writeFile(path.join(cwd, 'progress.html'), '<h1>Working</h1>');
    expect(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('Experimental progress view');
    prepareSessionWorkspace('progress', 'Custom profile', undefined, false);
    expect(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).not.toContain('Experimental progress view');
    expect(await fs.readFile(path.join(cwd, '.pane-progress.json'), 'utf8')).toBe('{"enabled":false}');
    await expect(readSessionProgress('progress', false)).resolves.toEqual({ state: 'disabled' });
    await expect(readSessionProgress('progress', true)).resolves.toMatchObject({ state: 'ready', html: '<h1>Working</h1>' });
  });

  it('handles missing progress, atomic replacement, oversized files and symlinks', async () => {
    const cwd = prepareSessionWorkspace('read-progress');
    const file = path.join(cwd, 'progress.html');
    await expect(readSessionProgress('read-progress', true)).resolves.toEqual({ state: 'empty' });
    await fs.writeFile(file, '<h1>First</h1>');
    const first = await readSessionProgress('read-progress', true);
    await fs.writeFile(path.join(cwd, 'next.html'), '<h1>Next</h1>');
    await fs.rename(path.join(cwd, 'next.html'), file);
    const second = await readSessionProgress('read-progress', true);
    expect(second).not.toEqual(first);
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await expect(readSessionProgress('read-progress', true)).rejects.toThrow('exceeds');
    await fs.unlink(file);
    await fs.symlink(path.join(cwd, 'AGENTS.md'), file);
    await expect(readSessionProgress('read-progress', true)).rejects.toThrow();
  });

});
